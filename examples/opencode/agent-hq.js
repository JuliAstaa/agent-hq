// Agent HQ plugin for OpenCode (docs/opencode.md). OpenCode 1.x plugin API, plain JavaScript, built-in modules only.
//
// Copy this file to ~/.config/opencode/plugins/ (all projects) or <project>/.opencode/plugins/ (one project).
// OpenCode events are translated to Claude Code hook payloads and posted to Agent HQ's /api/hook, so the bridge
// shows an OpenCode session like a Claude Code session: statuses, bubbles, task board, confetti, subagents in the
// meeting room, rename. States Claude Code has no hook for (permission answered, token total) go to /api/event.
//
// It never slows OpenCode down: hooks only queue a request and return, requests are sent in the background one at
// a time so their order is kept, errors are swallowed, and after Agent HQ could not be reached nothing is sent for
// 20 seconds. Settings: environment first, then agent-hq.env next to this file (see docs/opencode.md).
//
// Only plugin functions may be exported from this file: OpenCode treats every export as a plugin.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const RETRY_AFTER_MS = 20_000;
const MAX_QUEUE = 200; // requests waiting while Agent HQ is slow; more are dropped
const MAX_REMEMBERED = 2000; // message roles and failed tool calls kept in memory
const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: *(.+)$/gm;
const SUBAGENT_TITLE = /\(@([\w.-]+) subagent\)\s*$/;
// question.asked shows the wait for an answer; invalid is OpenCode's stand-in for a broken tool call.
const SKIP_TOOLS = new Set(["question", "invalid"]);
const QUIET_ERRORS = /aborted|rejected permission|permission.*(rejected|denied)/i;

// ------------------------------------------------------------------ settings

function here() {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

function readEnvFile(file) {
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

function loadConfig(env = process.env) {
  const file = readEnvFile(env.HQ_ENV_FILE || path.join(here(), "agent-hq.env"));
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
    disabled: ["1", "true", "yes", "on"].includes(get("HQ_DISABLE").toLowerCase()),
  };
}

// ------------------------------------------------------------------ ids and tools

// OpenCode ids start with a timestamp, while the bridge keys agents on the first 8 characters: hash them.
const sha1 = (v) => crypto.createHash("sha1").update(String(v)).digest("hex");
const hookSession = (raw) => sha1(raw || "unknown").slice(0, 16);
const hookAgent = (raw) => sha1(raw).slice(0, 8);
const projectName = (dir) => path.basename(String(dir || "").replace(/[\\/]+$/, "")) || "opencode";

function patchTool(text) {
  const files = [...String(text ?? "").matchAll(PATCH_FILE)];
  if (!files.length) return ["Edit", { file_path: "file" }];
  const [, kind, file] = files[0];
  const more = files.length > 1 ? ` (+${files.length - 1})` : "";
  return [kind === "Add" ? "Write" : "Edit", { file_path: file.trim() + more }];
}

/** OpenCode tool -> [Claude Code tool name, tool_input], so the bridge labels it like Claude Code's. */
function mapTool(tool, args) {
  const a = args && typeof args === "object" ? args : {};
  switch (tool) {
    case "bash":
      return ["Bash", { command: String(a.command ?? "") }];
    case "read":
      return ["Read", { file_path: a.filePath ?? a.path }];
    case "write":
      return ["Write", { file_path: a.filePath }];
    case "edit":
    case "multiedit":
      return ["Edit", { file_path: a.filePath }];
    case "apply_patch":
    case "patch":
      return patchTool(a.patchText ?? a.patch ?? a.input);
    case "grep":
      return ["Grep", { pattern: String(a.pattern ?? "") }];
    case "glob":
      return ["Glob", { pattern: String(a.pattern ?? "") }];
    case "list":
      return ["Glob", { pattern: String(a.path ?? ".") }];
    case "webfetch":
      return ["WebFetch", { url: String(a.url ?? "") }];
    case "websearch":
    case "codesearch":
      return ["WebSearch", { query: String(a.query ?? "") }];
    case "task":
      return ["Task", { description: a.description, subagent_type: a.subagent_type }];
    case "todowrite":
    case "todoread":
      return ["TodoWrite", {}];
    case "skill":
      return ["Read", { file_path: String(a.name ?? "skill") }];
    default:
      return [String(tool || "tool"), {}];
  }
}

/** A permission request -> the tool it guards, in Claude Code terms. */
function permissionTool(permission, patterns, metadata) {
  const pats = (Array.isArray(patterns) ? patterns : patterns ? [patterns] : []).map(String);
  const m = metadata && typeof metadata === "object" ? metadata : {};
  switch (permission) {
    case "bash":
      return ["Bash", { command: String(m.command ?? pats.join(" ")) }];
    case "edit":
    case "write":
      return ["Edit", { file_path: String(m.filepath ?? m.filePath ?? pats[0] ?? "file") }];
    case "read":
      return ["Read", { file_path: String(m.filepath ?? m.filePath ?? pats[0] ?? "file") }];
    case "webfetch":
      return ["WebFetch", { url: String(m.url ?? pats[0] ?? "") }];
    default:
      return [String(permission || "tool"), {}];
  }
}

function tokenSum(t) {
  if (!t || typeof t !== "object") return 0;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return n(t.input) + n(t.output) + n(t.reasoning) + n(t.cache?.read) + n(t.cache?.write);
}

const remember = (map, key, value) => {
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value);
};

// ------------------------------------------------------------------ http

// Tab, printable ASCII, and latin-1 only: no CR/LF, so a value can never start a new header.
const headerSafe = (v) => /^[\t\x20-\x7e\x80-\xff]*$/.test(v);

/**
 * POST JSON to Agent HQ. Resolves the status code, 0 when not reachable. Never rejects.
 * The request is written by hand on a socket: OpenCode runs on Bun, whose http client sends header values as
 * UTF-8, while Agent HQ (Node) reads them as latin-1, so "OpenCode · shop-api" would arrive as "OpenCode Â· ...".
 * Writing the header block as latin-1 matches what Node and Python clients send.
 */
function post(cfg, reqPath, body, headers) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(cfg.url + reqPath);
    } catch {
      resolve(0);
      return;
    }
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const lines = [
      `POST ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      "Content-Type: application/json",
      `Content-Length: ${data.length}`,
      "Connection: close",
    ];
    if (cfg.token && headerSafe(cfg.token)) lines.push(`Authorization: Bearer ${cfg.token}`);
    for (const [k, v] of Object.entries(headers || {})) if (v && headerSafe(v)) lines.push(`${k}: ${v}`);
    const head = Buffer.from(lines.join("\r\n") + "\r\n\r\n", "latin1");
    const secure = url.protocol === "https:";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port) || (secure ? 443 : 80);
    let done = false;
    let reply = "";
    let sock;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock?.destroy();
      resolve(code);
    };
    const timer = setTimeout(() => finish(0), cfg.timeout * 1000);
    try {
      sock = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
    } catch {
      finish(0);
      return;
    }
    sock.on(secure ? "secureConnect" : "connect", () => sock.write(Buffer.concat([head, data])));
    sock.on("data", (chunk) => {
      reply += chunk.toString("latin1");
      const m = reply.match(/^HTTP\/1\.[01] (\d{3})/);
      if (m) finish(Number(m[1]));
      else if (reply.length >= 16) finish(0); // not an HTTP answer
    });
    sock.on("error", () => finish(0));
    sock.on("close", () => finish(0));
  });
}

/** Background queue: one request at a time, in order. */
function createSender(cfg) {
  let chain = Promise.resolve();
  let queued = 0;
  let downUntil = 0;
  const send = (reqPath, body, headers) => {
    if (queued >= MAX_QUEUE) return;
    queued++;
    chain = chain
      .catch(() => {})
      .then(async () => {
        try {
          if (Date.now() < downUntil) return;
          if ((await post(cfg, reqPath, body, headers)) === 0) downUntil = Date.now() + RETRY_AFTER_MS;
        } finally {
          queued--;
        }
      });
  };
  send.flush = (ms) =>
    Promise.race([
      chain.catch(() => {}),
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        t.unref?.();
      }),
    ]);
  return send;
}

// ------------------------------------------------------------------ translation

function createTracker(cfg, directory) {
  const send = createSender(cfg);
  const sessions = new Map(); // OpenCode session id -> state
  const roles = new Map(); // message id -> "user" | "assistant"
  const failedCalls = new Map(); // tool call ids already reported as failed
  const asked = new Map(); // permission id -> tool name
  const taskTypes = new Map(); // session id -> subagent types of its `task` calls, oldest first

  const session = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = { id, parent: null, type: "", started: false, busy: false, ended: false, rejected: false, last: "", tokens: new Map(), sent: -1, retry: 0 };
      sessions.set(id, s);
    }
    return s;
  };
  const known = (id) => (id ? session(String(id)) : null);
  const mainOf = (s) => s.parent || s.id;
  const charId = (s) => {
    const sid = hookSession(mainOf(s));
    return s.parent ? `cc-${sid.slice(0, 6)}-${hookAgent(s.id)}` : `cc-${sid.slice(0, 8)}`;
  };
  const headers = () => ({
    "X-HQ-Name": cfg.name,
    "X-HQ-Role": cfg.role || `OpenCode · ${projectName(directory)}`,
    "X-HQ-Team": cfg.team,
    "X-HQ-Group": cfg.group,
  });

  const hook = (s, event, fields = {}) => {
    const body = { hook_event_name: event, session_id: hookSession(mainOf(s)), cwd: directory };
    if (s.parent) {
      body.agent_id = hookAgent(s.id);
      body.agent_type = s.type || "subagen";
    }
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== "") body[k] = v;
    send("/api/hook", body, headers());
  };
  const update = (s, fields) => send("/api/event", { type: "agent_update", id: charId(s), ...fields });

  const start = (s, model) => {
    if (s.started) return;
    s.started = true;
    s.ended = false;
    if (s.parent) hook(s, "SubagentStart");
    else hook(s, "SessionStart", { model });
  };

  const reportTokens = (s) => {
    let total = 0;
    for (const n of s.tokens.values()) total += n;
    if (total > 0 && total !== s.sent) {
      s.sent = total;
      update(s, { tokens: total });
    }
  };

  const idle = (id) => {
    const s = id ? sessions.get(String(id)) : null;
    if (!s || !s.busy) return; // session.idle and session.status idle both arrive; one turn ends once
    s.busy = false;
    if (s.rejected && !s.parent) {
      hook(s, "Notification", { notification_type: "idle_prompt", message: "" }); // stopped by "no": no confetti
    } else {
      hook(s, s.parent ? "SubagentStop" : "Stop", { last_assistant_message: s.last.slice(0, 1000) });
    }
    s.rejected = false;
    reportTokens(s);
  };

  return {
    chatMessage(input, output) {
      const s = known(input?.sessionID);
      if (!s) return;
      const m = input.model;
      start(s, m?.modelID ? (m.providerID ? `${m.providerID}/${m.modelID}` : m.modelID) : undefined);
      if (output?.message?.id) remember(roles, output.message.id, "user");
      s.busy = true;
      s.rejected = false;
      if (s.parent) return; // a subagent's prompt is its parent's task call
      s.last = "";
      const text = (Array.isArray(output?.parts) ? output.parts : [])
        .filter((p) => p?.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => String(p.text ?? ""))
        .join("\n")
        .trim();
      hook(s, "UserPromptSubmit", { prompt: text || "Prompt baru" });
    },

    toolBefore(input, output) {
      const s = known(input?.sessionID);
      if (!s) return;
      start(s);
      s.busy = true;
      s.rejected = false;
      const args = output?.args;
      if (input.tool === "task") {
        const queue = taskTypes.get(s.id) || [];
        queue.push(args?.subagent_type);
        taskTypes.set(s.id, queue.slice(-10));
      }
      if (SKIP_TOOLS.has(input.tool)) return;
      const [tool, toolInput] = mapTool(input.tool, args);
      hook(s, "PreToolUse", { tool_name: tool, tool_input: toolInput });
    },

    compacting(input) {
      const s = known(input?.sessionID);
      if (s?.started) hook(s, "PreCompact");
    },

    event(e) {
      const p = (e && e.properties) || {};
      switch (e?.type) {
        case "session.created": {
          const info = p.info;
          if (!info?.id || !info.parentID) return; // main sessions start with their first prompt
          const s = session(String(info.id));
          s.parent = mainOf(session(String(info.parentID)));
          const fromTask = taskTypes.get(String(info.parentID))?.shift();
          s.type = String(fromTask || String(info.title || "").match(SUBAGENT_TITLE)?.[1] || "subagen");
          s.busy = true;
          start(s);
          return;
        }
        case "message.updated": {
          const info = p.info;
          if (!info?.id) return;
          remember(roles, info.id, info.role);
          if (info.role === "assistant" && info.sessionID && info.tokens) known(info.sessionID).tokens.set(info.id, tokenSum(info.tokens));
          return;
        }
        case "message.part.updated": {
          const part = p.part;
          if (!part?.sessionID) return;
          if (part.type === "text" && !part.synthetic && roles.get(part.messageID) === "assistant") {
            known(part.sessionID).last = String(part.text ?? "").slice(0, 1000);
          } else if (part.type === "tool" && part.state?.status === "error" && part.callID && !failedCalls.has(part.callID)) {
            remember(failedCalls, part.callID, true);
            const error = String(part.state.error ?? "");
            if (QUIET_ERRORS.test(error)) return; // shown as "Izin ditolak" or as a stop instead
            hook(known(part.sessionID), "PostToolUseFailure", { tool_name: mapTool(part.tool, part.state.input)[0], error });
          }
          return;
        }
        case "permission.asked":
        case "permission.updated": {
          const s = known(p.sessionID);
          if (!s || (p.id && asked.has(p.id))) return;
          const [tool, toolInput] = permissionTool(p.permission ?? p.type, p.patterns ?? p.pattern, p.metadata);
          if (p.id) remember(asked, p.id, tool);
          start(s);
          s.busy = true;
          hook(s, "PermissionRequest", { tool_name: tool, tool_input: toolInput });
          return;
        }
        case "permission.replied": {
          const s = known(p.sessionID);
          if (!s) return;
          const reply = String(p.reply ?? p.response ?? "").toLowerCase();
          if (reply === "reject" || reply.startsWith("den")) {
            s.rejected = true;
            hook(s, "PermissionDenied", { tool_name: asked.get(p.requestID ?? p.permissionID) });
            update(s, { status: "thinking", task: "Izin ditolak, mencari cara lain" });
          } else {
            update(s, { status: "working", task: "Izin diberikan, lanjut kerja" });
          }
          return;
        }
        case "question.asked": {
          const s = known(p.sessionID);
          if (!s) return;
          const q = Array.isArray(p.questions) ? p.questions[0] : null;
          start(s);
          s.busy = true;
          hook(s, "Notification", { notification_type: "agent_needs_input", message: String(q?.question || q?.header || "Butuh jawabanmu") });
          return;
        }
        case "question.replied":
        case "question.rejected": {
          const s = known(p.sessionID);
          if (s) update(s, { status: "thinking", task: "Lanjut setelah jawabanmu" });
          return;
        }
        case "session.status": {
          const st = p.status;
          if (st?.type === "idle") idle(p.sessionID);
          else if (st?.type === "retry") {
            const s = known(p.sessionID);
            if (!s || st.attempt === s.retry) return;
            s.retry = st.attempt;
            // A Notification of another type is a plain log line, redacted by the bridge.
            hook(s, "Notification", { notification_type: "retry", message: `Coba lagi (${st.attempt}): ${st.message ?? ""}` });
          }
          return;
        }
        case "session.idle":
          idle(p.sessionID);
          return;
        case "session.error": {
          const s = known(p.sessionID);
          if (!s) return;
          start(s);
          s.busy = false;
          s.rejected = false;
          if (p.error?.name === "MessageAbortedError") {
            if (s.parent) hook(s, "SubagentStop");
            else hook(s, "Notification", { notification_type: "idle_prompt", message: "" });
          } else {
            hook(s, "StopFailure", { error: String(p.error?.data?.message || p.error?.name || "OpenCode error") });
          }
          return;
        }
        case "session.deleted": {
          const id = p.info?.id ? String(p.info.id) : "";
          const s = sessions.get(id);
          if (s && !s.parent && s.started && !s.ended) hook(s, "SessionEnd", { reason: "sesi dihapus" });
          sessions.delete(id);
          taskTypes.delete(id);
          return;
        }
      }
    },

    async dispose() {
      for (const s of sessions.values()) {
        if (s.parent || !s.started || s.ended) continue;
        s.ended = true;
        hook(s, "SessionEnd");
      }
      await send.flush(2000);
    },
  };
}

// ------------------------------------------------------------------ plugin

export const AgentHQ = async (input) => {
  try {
    const cfg = loadConfig();
    if (cfg.disabled) return {};
    const hq = createTracker(cfg, String(input?.directory || input?.worktree || process.cwd()));
    // Agent HQ must never break OpenCode: a hook that throws would stop the tool or the prompt.
    const safe =
      (fn) =>
      async (...args) => {
        try {
          fn(...args);
        } catch {}
      };
    return {
      event: safe(({ event }) => hq.event(event)),
      "chat.message": safe((i, o) => hq.chatMessage(i, o)),
      "tool.execute.before": safe((i, o) => hq.toolBefore(i, o)),
      "experimental.session.compacting": safe((i) => hq.compacting(i)),
      dispose: async () => {
        try {
          await hq.dispose();
        } catch {}
      },
    };
  } catch {
    return {};
  }
};
