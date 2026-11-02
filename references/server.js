#!/usr/bin/env node
// Agent HQ bridge: agen kirim event lewat HTTP POST, kantor 3D terima lewat SSE.
// Tanpa dependency. Jalankan: node server.js   lalu buka http://localhost:8787
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
const PAGE = path.join(__dirname, 'agent-hq.html');

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
function publish(ev) { ev.ts = ev.ts || new Date().toISOString(); remember(ev); broadcast(ev); }

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

  if (req.method === 'GET' && url.pathname === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    send(res, { type: 'snapshot', agents: [...agents.values()] });
    for (const ev of recent.slice(-30)) send(res, { ...ev, _replay: true });
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/event') {
    if (!authorized(req)) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"ok":false,"error":"token salah"}'); return; }
    try {
      const parsed = JSON.parse(await readBody(req));
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const ev of list) if (ev && typeof ev === 'object') publish(ev);
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, received: list.length }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Claude Code http hook. Selalu balas 200 kosong supaya Claude tidak pernah terblokir.
  if (req.method === 'POST' && url.pathname === '/hook') {
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

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, agents: agents.size, viewers: clients.size }));
    return;
  }

  res.writeHead(404).end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Agent HQ jalan di http://${HOST}:${PORT}`);
  console.log(`Hook Claude Code: POST http://${HOST}:${PORT}/hook  (lihat claude-hooks.settings.json)`);
});
