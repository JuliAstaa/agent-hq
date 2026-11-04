#!/usr/bin/env node
// Agent HQ hook for OpenAI Codex CLI (docs/codex.md). Node.js 18+, built-in modules only.
//
// Codex runs this once per hook event (type "command" in ~/.codex/hooks.json) and pipes one JSON object to
// stdin. Codex hooks already use Claude Code's event names and fields, so the payload is forwarded to Agent HQ's
// /api/hook with a few changes:
// - session and subagent ids are hashed: Codex ids are UUIDv7, whose first characters are a timestamp, while the
//   bridge keys agents on the first 8 characters;
// - Codex tool names become their Claude Code counterparts (apply_patch -> Edit or Write, update_plan -> TodoWrite)
//   so bubbles read the same; Interrupt becomes an idle Notification;
// - the role defaults to "Codex · <folder>".
// The token total (total_token_usage in the Codex transcript) goes to /api/event.
//
// It never blocks Codex: prints nothing on stdout, always exits 0, waits at most HQ_TIMEOUT seconds per request,
// and after Agent HQ could not be reached it stays quiet for 20 seconds.
//
//   node hq_codex.mjs --dry-run < event.json   # print the requests instead of sending them
//   node hq_codex.mjs --test                   # send a test character and print the result

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RETRY_AFTER_MS = 20_000;
const TAIL_BYTES = 1 << 20; // transcript tail searched for the latest token total

function userTag() {
  try {
    return String(process.getuid?.() ?? os.userInfo().username);
  } catch {
    return "user";
  }
}

/** Codex hook events this script forwards. Others (PostToolUse, model requests) carry nothing to show. */
export const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PreCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
  "SessionEnd",
];
const EVENT_SET = new Set(EVENTS);
// Codex names subagents without a role "default"; those get a short suffix so several stay apart.
const GENERIC_AGENT_TYPES = new Set(["", "default"]);
const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: *(.+)$/gm;

// ------------------------------------------------------------------ settings

const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());

/** KEY=VALUE lines (optional `export`, quotes, # comments) -> object. Missing file -> {}. */
export function readEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && val[0] === val[val.length - 1] && (val[0] === '"' || val[0] === "'")) val = val.slice(1, -1);
    else val = val.split(/\s+#/)[0];
    out[line.slice(0, eq).trim()] = val;
  }
  return out;
}

/** Settings: environment first, then agent-hq.env next to this script, then defaults. */
export function loadConfig(env = process.env) {
  const file = readEnvFile(env.HQ_ENV_FILE || path.join(HERE, "agent-hq.env"));
  const get = (k, d = "") => String(env[k] || file[k] || d).trim();
  let url = get("HQ_URL", "http://127.0.0.1:8787").replace(/\/+$/, "");
  if (url.endsWith("/api")) url = url.slice(0, -4);
  const t = Number(get("HQ_TIMEOUT", "1.5"));
  return {
    url,
    token: get("HQ_TOKEN"),
    name: get("HQ_NAME"),
    role: get("HQ_ROLE"),
    team: get("HQ_TEAM"),
    group: get("HQ_GROUP"),
    timeout: Number.isFinite(t) ? Math.min(10, Math.max(0.2, t)) : 1.5,
    disabled: truthy(get("HQ_DISABLE")),
    dryRun: truthy(get("HQ_DRY_RUN")),
    // Remembers "Agent HQ unreachable" across runs (one process per event).
    downFile: path.join(get("HQ_STATE_DIR") || os.tmpdir(), `agent-hq-codex-${userTag()}.down`),
  };
}

// ------------------------------------------------------------------ ids

const sha1 = (v) => crypto.createHash("sha1").update(String(v)).digest("hex");
/** session_id sent to /api/hook. */
export const hookSession = (raw) => sha1(raw || "unknown").slice(0, 16);
/** agent_id sent to /api/hook for a subagent. */
export const hookAgent = (raw) => sha1(raw).slice(0, 8);

/** The id the bridge gives the character (hookAgentId in lib/bridge/hooks.ts). */
export function agentIdFor(rawSession, rawAgent) {
  const sid = hookSession(rawSession);
  return rawAgent ? `cc-${sid.slice(0, 6)}-${hookAgent(rawAgent)}` : `cc-${sid.slice(0, 8)}`;
}

const projectName = (cwd) => path.basename(String(cwd || "").replace(/[\\/]+$/, "")) || "codex";

// ------------------------------------------------------------------ translation

function patchTool(text) {
  const files = [...String(text ?? "").matchAll(PATCH_FILE)];
  if (!files.length) return ["Edit", { file_path: "file" }];
  const [, kind, file] = files[0];
  const more = files.length > 1 ? ` (+${files.length - 1})` : "";
  return [kind === "Add" ? "Write" : "Edit", { file_path: file.trim() + more }];
}

function shellCommand(i) {
  const c = i.command ?? i.cmd ?? "";
  if (!Array.isArray(c)) return String(c);
  // ["bash", "-lc", "<script>"] -> "<script>"
  if (c.length === 3 && /^-l?c$/.test(String(c[1]))) return String(c[2]);
  return c.map(String).join(" ");
}

/** Codex tool -> [Claude Code tool name, tool_input], so the bridge labels it like Claude Code's. */
export function mapTool(name, input) {
  const i = input && typeof input === "object" ? input : {};
  switch (name) {
    case "Bash":
    case "exec_command":
    case "shell":
    case "local_shell":
      return ["Bash", { command: shellCommand(i) }];
    case "apply_patch":
      return patchTool(i.command ?? i.patch ?? i.input);
    case "update_plan":
      return ["TodoWrite", {}];
    case "view_image":
      return ["Read", { file_path: String(i.path || "gambar") }];
    default:
      return [String(name || "tool"), /^mcp__/.test(String(name)) ? {} : i];
  }
}

function agentType(raw, hashed) {
  const t = String(raw ?? "").trim();
  return GENERIC_AGENT_TYPES.has(t.toLowerCase()) ? `subagen#${hashed.slice(0, 4)}` : t;
}

/** One Codex hook payload -> the Claude Code hook payload for /api/hook, or null when it shows nothing. */
export function translate(p) {
  if (!p || typeof p !== "object") return null;
  const ev = String(p.hook_event_name || "");
  if (!EVENT_SET.has(ev)) return null;
  const out = { hook_event_name: ev, session_id: hookSession(p.session_id), cwd: String(p.cwd || "") };
  if (p.agent_id) {
    out.agent_id = hookAgent(p.agent_id);
    out.agent_type = agentType(p.agent_type, out.agent_id);
  }
  switch (ev) {
    case "SessionStart":
      if (p.source) out.source = String(p.source);
      if (p.model) out.model = String(p.model);
      break;
    case "UserPromptSubmit":
      out.prompt = String(p.prompt ?? "");
      break;
    case "PreToolUse":
    case "PermissionRequest": {
      const [tool, input] = mapTool(p.tool_name, p.tool_input);
      out.tool_name = tool;
      out.tool_input = input;
      break;
    }
    case "Stop":
    case "SubagentStop":
      if (p.last_assistant_message) out.last_assistant_message = String(p.last_assistant_message).slice(0, 1000);
      break;
    case "Interrupt":
      // Claude Code has no interrupt hook; an idle prompt shows "Menunggu prompt berikutnya".
      return { ...out, hook_event_name: "Notification", notification_type: "idle_prompt", message: "" };
    case "SessionEnd":
      if (p.reason && p.reason !== "other") out.reason = String(p.reason);
      break;
  }
  return out;
}

/** Latest cumulative token total in a Codex transcript (rollout .jsonl), or null. Odd lines are skipped. */
export function transcriptTokens(file) {
  if (typeof file !== "string" || !file.endsWith(".jsonl")) return null;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    for (let k = lines.length - 1; k >= 0; k--) {
      if (!lines[k].includes('"total_token_usage"')) continue;
      try {
        const n = Number(JSON.parse(lines[k])?.payload?.info?.total_token_usage?.total_tokens);
        if (Number.isFinite(n) && n >= 0) return n;
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
  return null;
}

/** Codex hook payload -> list of [path, body] requests for Agent HQ. */
export function requestsFor(p) {
  const hook = translate(p);
  if (!hook) return [];
  const out = [["/api/hook", hook]];
  const ev = hook.hook_event_name;
  let file = null;
  if (ev === "SubagentStop") file = p.agent_transcript_path;
  else if ((ev === "Stop" || ev === "UserPromptSubmit") && !p.agent_id) file = p.transcript_path;
  const tokens = file ? transcriptTokens(file) : null;
  if (tokens !== null) out.push(["/api/event", { type: "agent_update", id: agentIdFor(p.session_id, p.agent_id), tokens }]);
  return out;
}

export function headersFor(cfg, reqPath, body) {
  if (reqPath !== "/api/hook") return {};
  return {
    "X-HQ-Name": cfg.name,
    "X-HQ-Role": cfg.role || `Codex · ${projectName(body.cwd)}`,
    "X-HQ-Team": cfg.team,
    "X-HQ-Group": cfg.group,
  };
}

// ------------------------------------------------------------------ http

// Node only sends header values made of tab, printable ASCII, and latin-1; anything else is left out.
const headerSafe = (v) => /^[\t\x20-\x7e\x80-\xff]*$/.test(v);

/** POST JSON to Agent HQ. Resolves [status, error]: status 0 means not reachable. Never rejects. */
export function post(cfg, reqPath, body, headers = {}) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(cfg.url + reqPath);
    } catch (e) {
      resolve([0, String(e.message)]);
      return;
    }
    const data = Buffer.from(JSON.stringify(body));
    const h = { "content-type": "application/json", "content-length": String(data.length) };
    if (cfg.token) h.authorization = `Bearer ${cfg.token}`;
    for (const [k, v] of Object.entries(headers)) if (v && headerSafe(v)) h[k] = v;
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method: "POST", headers: h }, (res) => {
      res.resume();
      res.on("end", () => resolve([res.statusCode || 0, res.statusCode === 401 ? "HTTP 401 (HQ_TOKEN salah?)" : `HTTP ${res.statusCode}`]));
    });
    const timer = setTimeout(() => req.destroy(new Error(`tidak menjawab dalam ${cfg.timeout} detik`)), cfg.timeout * 1000);
    req.on("error", (e) => resolve([0, e.code || e.message]));
    req.on("close", () => clearTimeout(timer));
    req.end(data);
  });
}

function downUntil(cfg) {
  try {
    return Number(fs.readFileSync(cfg.downFile, "utf8")) || 0;
  } catch {
    return 0;
  }
}

function setDown(cfg, until) {
  try {
    if (until) {
      fs.mkdirSync(path.dirname(cfg.downFile), { recursive: true });
      fs.writeFileSync(cfg.downFile, String(until));
    } else fs.rmSync(cfg.downFile, { force: true });
  } catch {}
}

async function send(cfg, requests) {
  const down = downUntil(cfg);
  if (!requests.length || down > Date.now()) return;
  let reachable = true;
  for (const [reqPath, body] of requests) {
    const [status] = await post(cfg, reqPath, body, headersFor(cfg, reqPath, body));
    if (status === 0) {
      reachable = false;
      break;
    }
  }
  if (!reachable) setDown(cfg, Date.now() + RETRY_AFTER_MS);
  else if (down) setDown(cfg, 0);
}

// ------------------------------------------------------------------ cli

async function selfTest(cfg) {
  const sid = `hq-codex-test-${Date.now()}`;
  const base = { session_id: sid, cwd: process.cwd(), model: "tes" };
  const steps = [
    { ...base, hook_event_name: "SessionStart", source: "startup" },
    { ...base, hook_event_name: "UserPromptSubmit", prompt: "Tes koneksi dari hq_codex.mjs" },
    { ...base, hook_event_name: "Stop", last_assistant_message: "Tes berhasil" },
    { ...base, hook_event_name: "SessionEnd", reason: "tes selesai" },
  ];
  const testCfg = { ...cfg, name: cfg.name || "Tes Codex" };
  for (const step of steps) {
    const body = translate(step);
    const [status, error] = await post(testCfg, "/api/hook", body, headersFor(testCfg, "/api/hook", body));
    if (status < 200 || status >= 300) {
      process.stdout.write(`GAGAL: ${cfg.url} ${status ? error : `tidak terjangkau (${error})`}\n`);
      return 1;
    }
  }
  setDown(cfg, 0);
  process.stdout.write(`OK: karakter "${testCfg.name}" dikirim ke ${cfg.url}. Ia offline dan hilang 5 menit lagi.\n`);
  return 0;
}

async function main(argv) {
  const cfg = loadConfig();
  if (argv.includes("--test")) return selfTest(cfg);
  if (cfg.disabled) return 0;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8") || "null");
  } catch {
    return 0;
  }
  const requests = requestsFor(payload);
  if (cfg.dryRun || argv.includes("--dry-run")) {
    for (const [reqPath, body] of requests) {
      process.stdout.write(JSON.stringify({ path: reqPath, headers: headersFor(cfg, reqPath, body), body }) + "\n");
    }
    return 0;
  }
  await send(cfg, requests);
  return 0;
}

const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
const same = process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
if (same) {
  main(process.argv.slice(2))
    .catch(() => 0) // never break Codex because of Agent HQ
    .then((code) => process.exit(code || 0));
}
