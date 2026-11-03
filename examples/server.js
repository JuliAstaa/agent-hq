#!/usr/bin/env node
// Agent HQ bridge: agen kirim event lewat HTTP POST, kantor 3D terima lewat SSE.
// Salinan references/server.js (prototipe, read-only) dengan tambahan rename agen, sama dengan app Next.js:
//   POST /event {"type":"rename","match":"<id|nama|awalan session>","name":"..","team":"..","role":".."}
//   GET  /agents   daftar agen {id, name, role, team, status, renamed}
//   override nama disimpan di HQ_NAMES_FILE (default ./agent-hq-names.json di folder tempat server dijalankan)
//   semua URL juga bisa dipanggil dengan awalan /api (/api/event, /api/hook, ...), seperti app Next.js.
// Tanpa dependency. Jalankan: node examples/server.js   lalu buka http://localhost:8787
//
//   POST /event    body: 1 event Agent HQ atau array event
//   POST /hook     payload mentah dari Claude Code hooks (type: "http"), diterjemahkan otomatis
//   GET  /stream   Server-Sent Events (dipakai agent-hq.html)
//   GET  /health   status singkat
//
// Env: PORT (default 8787), HOST (default 127.0.0.1), HQ_TOKEN (opsional, wajib di header kalau di-set)
// Header opsional dari hook Claude Code: X-HQ-Name, X-HQ-Role, X-HQ-Team (red | report | blue)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.HQ_TOKEN || '';
const PAGE = process.env.HQ_PAGE || [path.join(__dirname, 'agent-hq.html'), path.join(__dirname, '..', 'references', 'agent-hq.html')].find((p) => fs.existsSync(p));
const NAMES_FILE = process.env.HQ_NAMES_FILE || path.join(process.cwd(), 'agent-hq-names.json');

const clients = new Set();
const agents = new Map();   // id -> state terakhir (untuk snapshot ke client baru)
const recent = [];          // log, temuan, alert terakhir (diputar ulang ke viewer baru)
const lastSeen = new Map(); // id -> timestamp event terakhir (untuk auto-remove subagen)

const idOf = ev => String(ev.id ?? ev.agent_id ?? ev.agentId ?? ev.agent ?? ev.name ?? 'agent');

function remember(ev) {
  const type = String(ev.type || 'agent_update').toLowerCase();
  const id = idOf(ev);
  lastSeen.set(id, Date.now());
  if (type === 'remove') { agents.delete(id); lastSeen.delete(id); return; }
  if (['log', 'finding', 'alert', 'metric'].includes(type)) {
    if (type !== 'metric') { recent.push(ev); if (recent.length > 80) recent.shift(); }
    if (ev.id == null && ev.agent_id == null && ev.agent == null) return;   // event tanpa agen
    if (!agents.has(id)) agents.set(id, { id, ...(ev.name ? { name: ev.name } : {}) });
    return;
  }
  const next = { ...(agents.get(id) || { id }) };
  for (const k of ['name', 'role', 'status', 'state', 'task', 'current_task', 'progress', 'tokens', 'cost', 'team']) {
    if (ev[k] !== undefined) next[k] = ev[k];
  }
  if (ev.tokens_delta !== undefined) next.tokens = (Number(next.tokens) || 0) + Number(ev.tokens_delta);
  if (type === 'task_done') { next.status = ev.status || 'idle'; next.progress = 1; }
  agents.set(id, next);
}

function send(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
function broadcast(obj) { for (const res of clients) send(res, obj); }
function publish(ev) { ev.ts = ev.ts || new Date().toISOString(); applyIdentity(ev); remember(ev); broadcast(ev); }

/* ---------------- rename: override name/role/team per agent id ---------------- */
const FIELDS = ['name', 'role', 'team'];
const MAX_LEN = 60;
const sourceIdentity = new Map(); // id -> identitas terakhir dari agen sendiri (fallback saat override dihapus)
const hasIdentity = (o) => !!o && FIELDS.some((f) => o[f] !== undefined);

function loadOverrides() {
  const out = new Map();
  let raw;
  try { raw = fs.readFileSync(NAMES_FILE, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[hq] tidak bisa membaca ${NAMES_FILE}:`, e.message);
    return out;
  }
  try {
    for (const [id, o] of Object.entries(JSON.parse(raw).agents || {})) {
      if (!o || typeof o !== 'object') continue;
      const clean = {};
      for (const f of FIELDS) if (typeof o[f] === 'string' && o[f]) clean[f] = o[f];
      if (typeof o.updatedAt === 'string') clean.updatedAt = o.updatedAt;
      if (hasIdentity(clean)) out.set(id, clean);
    }
  } catch (e) { console.warn(`[hq] ${NAMES_FILE} bukan JSON yang valid, override nama diabaikan:`, e.message); }
  return out;
}
const overrides = loadOverrides();

function saveOverrides() {
  const agentsOut = {};
  for (const [id, o] of [...overrides].sort(([a], [b]) => a.localeCompare(b))) if (hasIdentity(o)) agentsOut[id] = o;
  const tmp = `${NAMES_FILE}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(NAMES_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, agents: agentsOut }, null, 2) + '\n');
  fs.renameSync(tmp, NAMES_FILE);
}

function applyIdentity(ev) {
  if (!['agent_update', 'task_done'].includes(String(ev.type || 'agent_update').toLowerCase())) return;
  const id = idOf(ev);
  if (!ev._renamed) {
    const src = { ...(sourceIdentity.get(id) || {}) };
    for (const f of FIELDS) if (typeof ev[f] === 'string' && ev[f]) src[f] = ev[f];
    sourceIdentity.set(id, src);
  }
  delete ev._renamed;
  const o = overrides.get(id);
  if (o) for (const f of FIELDS) if (o[f] !== undefined) ev[f] = o[f];
}

function identityOf(id) {
  const a = agents.get(id) || {};
  return { name: String(a.name ?? id), role: a.role == null ? null : String(a.role), team: a.team == null ? null : String(a.team) };
}

function listAgents() {
  return [...agents.values()].map((a) => {
    const id = String(a.id);
    const status = a.status == null ? (a.state == null ? null : String(a.state)) : String(a.status);
    return { id, ...identityOf(id), status, renamed: overrides.has(id) };
  });
}

function findAgent(id, match) {
  const notFound = (what) => ({ status: 404, error: `Agen ${what} tidak ditemukan. Cek daftar agen dengan GET /agents (atau /api/agents).` });
  if (id != null && id !== '') { const s = String(id); return agents.has(s) ? { id: s, matchedBy: 'id' } : notFound(`dengan id "${s}"`); }
  const m = typeof match === 'string' || typeof match === 'number' ? String(match).trim() : '';
  if (!m) return { status: 400, error: 'rename butuh "id" atau "match"' };
  if (agents.has(m)) return { id: m, matchedBy: 'id' };
  const ids = [...agents.keys()];
  const lower = m.toLowerCase();
  const byName = ids.filter((i) => identityOf(i).name.toLowerCase() === lower);
  if (byName.length === 1) return { id: byName[0], matchedBy: 'name' };
  if (byName.length > 1) return { status: 409, error: `Nama "${m}" dipakai ${byName.length} agen, pakai id.`, candidates: byName };
  const bare = lower.replace(/^cc-/, '');
  const byPrefix = ids.filter((i) => i.toLowerCase().startsWith(lower) || i.toLowerCase().replace(/^cc-/, '').startsWith(bare));
  if (byPrefix.length === 1) return { id: byPrefix[0], matchedBy: 'prefix' };
  const main = byPrefix.filter((i) => /^cc-[^-]+$/.test(i));
  if (main.length === 1) return { id: main[0], matchedBy: 'prefix' };
  if (byPrefix.length > 1) return { status: 409, error: `"${m}" cocok dengan ${byPrefix.length} agen, pakai id.`, candidates: byPrefix };
  return notFound(`"${m}"`);
}

function renameAgent(ev) {
  const found = findAgent(ev.id, ev.match);
  if (!found.id) return { status: found.status, body: { ok: false, error: found.error, ...(found.candidates ? { candidates: found.candidates } : {}) } };
  const id = found.id;
  const next = { ...(overrides.get(id) || {}) };
  const cleared = [];
  let touched = false;
  for (const f of FIELDS) {
    if (!(f in ev)) continue;
    touched = true;
    const v = ev[f];
    if (v === null || v === '' || (typeof v === 'string' && !v.trim())) { if (next[f] !== undefined) cleared.push(f); delete next[f]; }
    else if (typeof v === 'string') {
      const s = v.replace(/\s+/g, ' ').trim();
      if (s.length > MAX_LEN) return { status: 400, body: { ok: false, error: `${f} terlalu panjang (maks ${MAX_LEN} karakter)` } };
      next[f] = s;
    } else return { status: 400, body: { ok: false, error: `${f} harus string, null, atau ""` } };
  }
  if (!touched) return { status: 400, body: { ok: false, error: 'rename butuh minimal satu field: "name", "team", atau "role"' } };
  next.updatedAt = new Date().toISOString();
  const before = identityOf(id);
  if (hasIdentity(next)) overrides.set(id, next); else overrides.delete(id);
  try { saveOverrides(); } catch (e) { return { status: 500, body: { ok: false, error: `gagal menyimpan ${NAMES_FILE}: ${e.message}` } }; }
  const o = overrides.get(id) || {};
  const src = sourceIdentity.get(id) || {};
  const update = { type: 'agent_update', id, _renamed: true };
  for (const f of FIELDS) {
    const v = o[f] ?? (cleared.includes(f) || f in ev ? src[f] : undefined);
    if (v !== undefined) update[f] = v;
  }
  if ('team' in ev && !o.team) update.team = 'office'; // team dihapus: balik ke meja kantor
  if ('name' in ev && update.name === undefined) update.name = id;
  publish(update);
  return { status: 202, body: { ok: true, id, matchedBy: found.matchedBy, before, after: identityOf(id), override: hasIdentity(o) ? o : null, file: NAMES_FILE } };
}

function authorized(req) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${TOKEN}` || req.headers['x-hq-token'] === TOKEN;
}

function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body terlalu besar')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------------- Claude Code hooks -> event Agent HQ ---------------- */
const trunc = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// sembunyikan rahasia yang sering muncul di command / prompt
const redact = s => String(s ?? '')
  .replace(/(bearer\s+)[\w.\-~+/=]+/gi, '$1***')
  .replace(/((?:api[_-]?key|token|secret|passw(?:or)?d|pwd|authorization)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
  .replace(/(-p\s*)\S+(?=.*\bmysql\b)/gi, '$1***')
  .replace(/\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{10,}\b/g, '***');
const base = p => (p ? path.basename(String(p)) : '');

function describeTool(name, input = {}) {
  const i = input || {};
  if (name === 'Bash') return `$ ${trunc(redact(i.command || i.description), 90)}`;
  if (name === 'Write') return `Menulis ${base(i.file_path)}`;
  if (name === 'Edit' || name === 'MultiEdit') return `Edit ${base(i.file_path)}`;
  if (name === 'NotebookEdit') return `Edit notebook ${base(i.notebook_path)}`;
  if (name === 'Read') return `Baca ${base(i.file_path)}`;
  if (name === 'Grep') return `Cari "${trunc(i.pattern, 40)}"`;
  if (name === 'Glob') return `Cari file ${trunc(i.pattern, 40)}`;
  if (name === 'WebSearch') return `Search: ${trunc(i.query, 60)}`;
  if (name === 'WebFetch') { try { return `Buka ${new URL(i.url).host}`; } catch { return 'Buka halaman web'; } }
  if (name === 'Task' || name === 'Agent') return `Delegasi: ${trunc(i.description || i.subagent_type || 'subagen', 60)}`;
  if (name === 'TodoWrite' || name === 'TaskCreate' || name === 'TaskUpdate') return 'Update daftar tugas';
  if (/^mcp__/.test(name)) { const [, srv, tool] = name.split('__'); return `MCP ${srv}: ${tool}`; }
  return name || 'tool';
}
const QUIET_TOOLS = new Set(['Read', 'Grep', 'Glob', 'TodoWrite', 'TaskUpdate', 'TaskCreate']);

const removeTimers = new Map();
function scheduleRemove(id, ms) {
  clearTimeout(removeTimers.get(id));
  const mark = Date.now();
  removeTimers.set(id, setTimeout(() => {
    if ((lastSeen.get(id) || 0) <= mark + 50) publish({ type: 'remove', id });
  }, ms));
}

function hookToEvents(h, hdr) {
  const evName = h.hook_event_name;
  const sid = String(h.session_id || 'unknown');
  const proj = base(h.cwd) || 'claude';
  const isSub = !!h.agent_id;
  const id = isSub ? `cc-${sid.slice(0, 6)}-${String(h.agent_id).slice(0, 8)}` : `cc-${sid.slice(0, 8)}`;
  const team = (hdr['x-hq-team'] || '').trim();
  const who = {
    id,
    name: isSub ? trunc(h.agent_type || 'subagen', 18) : (hdr['x-hq-name'] || `${proj}#${sid.slice(0, 4)}`),
    role: isSub ? `Subagen · ${proj}` : (hdr['x-hq-role'] || `Claude Code · ${proj}`),
    ...(team ? { team } : {}),
    source: 'claude-code',
  };
  const up = (extra) => ({ type: 'agent_update', ...who, ...extra });
  const log = (message, level = 'info') => ({ type: 'log', id, level, message: trunc(redact(message), 180) });
  const tool = h.tool_name;

  switch (evName) {
    case 'SessionStart':
      return [up({ status: 'idle', task: `Sesi ${h.source || 'baru'} di ${proj}${h.model ? ' · ' + h.model : ''}` })];
    case 'UserPromptSubmit':
      return [up({ status: 'thinking', task: trunc(redact(h.prompt || 'Prompt baru'), 140), progress: null }), log('Prompt baru masuk')];
    case 'PreToolUse': {
      const d = describeTool(tool, h.tool_input);
      const out = [up({ status: 'working', task: d })];
      if (!QUIET_TOOLS.has(tool)) out.push(log(`${tool}: ${d}`));
      return out;
    }
    case 'PostToolUseFailure':
      return [log(`${tool || 'Tool'} gagal: ${trunc(h.error || h.message || '', 120)}`, 'warn')];
    case 'PermissionRequest':
      return [up({ status: 'waiting', task: `Minta izin: ${describeTool(tool, h.tool_input)}` }), log(`Menunggu izin untuk ${tool}`, 'warn')];
    case 'PermissionDenied':
      return [log(`Izin ditolak: ${tool || ''}`, 'warn')];
    case 'Notification': {
      const t = String(h.notification_type || '');
      const msg = h.message || 'Butuh perhatian';
      if (/permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog/.test(t)) return [up({ status: 'waiting', task: trunc(msg, 120) }), log(msg, 'warn')];
      if (t === 'idle_prompt') return [up({ status: 'idle', task: 'Menunggu prompt berikutnya' })];
      return [log(msg)];
    }
    case 'Stop':
    case 'SubagentStop': {
      const out = [{ type: 'task_done', ...who, status: 'idle' }];
      if (h.last_assistant_message) out.push(log(`Selesai: ${h.last_assistant_message}`));
      if (evName === 'SubagentStop') scheduleRemove(id, 45000);
      return out;
    }
    case 'StopFailure':
      return [up({ status: 'error' }), log(`Gagal berhenti normal: ${h.error || h.message || evName}`, 'error')];
    case 'SubagentStart':
      return [up({ status: 'working', task: `Subagen ${h.agent_type || ''} mulai` })];
    case 'PreCompact':
      return [up({ status: 'thinking', task: 'Merangkum konteks (compact)' })];
    case 'TaskCreated':
    case 'TaskCompleted':
      return [log(`${evName === 'TaskCreated' ? 'Tugas baru' : 'Tugas selesai'}: ${h.task?.subject || h.subject || h.description || ''}`)];
    case 'SessionEnd':
      scheduleRemove(id, 5 * 60 * 1000);
      return [up({ status: 'offline', task: `Sesi selesai${h.reason ? ' (' + h.reason + ')' : ''}` })];
    default:
      return [];
  }
}

/* ---------------- HTTP ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // /api/event, /api/hook, /api/stream, /api/health, /api/agents: sama dengan app Next.js
  const pathname = url.pathname.replace(/^\/api(?=\/(event|hook|stream|health|agents)$)/, '');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-hq-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(PAGE, 'utf8', (err, html) => {
      if (err) { res.writeHead(500).end('agent-hq.html tidak ditemukan di folder yang sama'); return; }
      html = html.replace('<!--HQ_CONFIG-->', '<script>window.AGENT_HQ_STREAM = "/stream";</script>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    send(res, { type: 'snapshot', agents: [...agents.values()] });
    for (const ev of recent.slice(-30)) send(res, { ...ev, _replay: true });
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (req.method === 'POST' && pathname === '/event') {
    if (!authorized(req)) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"ok":false,"error":"token salah"}'); return; }
    try {
      const parsed = JSON.parse(await readBody(req));
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const renames = [];
      for (const ev of list) {
        if (!ev || typeof ev !== 'object') continue;
        if (String(ev.type || '').toLowerCase() === 'rename') renames.push(renameAgent(ev)); else publish(ev);
      }
      const reply = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (!renames.length) reply(202, { ok: true, received: list.length });
      else if (!Array.isArray(parsed)) reply(renames[0].status, renames[0].body);
      else { const failed = renames.find((r) => r.status >= 400); reply(failed ? failed.status : 202, { ok: !failed, received: list.length, renames: renames.map((r) => r.body) }); }
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Claude Code http hook. Selalu balas 200 kosong supaya Claude tidak pernah terblokir.
  if (req.method === 'POST' && pathname === '/hook') {
    if (!authorized(req)) { res.writeHead(401).end(); return; }
    try {
      const h = JSON.parse(await readBody(req));
      for (const ev of hookToEvents(h, req.headers)) publish(ev);
      if (process.env.HQ_DEBUG) console.log('[hook]', h.hook_event_name, h.tool_name || '');
    } catch (e) {
      console.warn('[hook] payload tidak terbaca:', e.message);
    }
    res.writeHead(200).end();
    return;
  }

  if (req.method === 'GET' && pathname === '/agents') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, agents: listAgents() }));
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, agents: agents.size, viewers: clients.size }));
    return;
  }

  res.writeHead(404).end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Agent HQ jalan di http://${HOST}:${PORT}`);
  console.log(`Hook Claude Code: POST http://${HOST}:${PORT}/hook  (lihat claude-hooks.settings.json)`);
});
