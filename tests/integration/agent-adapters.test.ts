// Adapters for Codex (examples/codex), OpenCode (examples/opencode), and the Claude Code hook installer
// (examples/claude). Codex and OpenCode payloads are checked through the bridge's own translator (hookToEvents),
// the scripts against a fake Agent HQ over HTTP, and the installers on temporary config folders.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hookToEvents } from "@/lib/bridge/hooks";
import * as codex from "../../examples/codex/hq_codex.mjs";
import { AgentHQ } from "../../examples/opencode/agent-hq.js";

const EX = path.resolve(__dirname, "../../examples");
const CODEX = path.join(EX, "codex", "hq_codex.mjs");
const CODEX_INSTALL = path.join(EX, "codex", "install.mjs");
const CLAUDE_INSTALL = path.join(EX, "claude", "install.mjs");
const CLOSED = "http://127.0.0.1:9"; // nothing listens on the discard port: connection refused at once

// Windows takes up to ~2 s to refuse a localhost connection, and the installers check Agent HQ once per run.
vi.setConfig({ testTimeout: 30_000 });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hq-adapters-"));
type Json = Record<string, unknown>;
type Got = { path: string; headers: http.IncomingHttpHeaders; body: Json };

/** Environment for a child process without the developer's own HQ_* settings. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("HQ_")) delete env[k];
  return Object.assign(env, extra);
}

function runNode(args: string[], input: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    child.stdin.end(input);
  });
}

/** What Agent HQ broadcasts for a request: /api/hook bodies go through the bridge's translator. */
function toEvents(reqPath: string, headers: Record<string, unknown>, body: Json): Json[] {
  if (reqPath !== "/api/hook") return [body];
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v ?? "")]));
  return hookToEvents(body, (n) => h[n], () => {}) as Json[];
}

let hq: http.Server;
let hqUrl = "";
const got: Got[] = [];

beforeAll(async () => {
  hq = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      got.push({ path: req.url || "", headers: req.headers, body: b ? JSON.parse(b) : {} });
      res.statusCode = req.headers.authorization === "Bearer salah" ? 401 : 200;
      res.end();
    });
  });
  await new Promise<void>((r) => hq.listen(0, "127.0.0.1", r));
  hqUrl = `http://127.0.0.1:${(hq.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => hq.close(() => r())));

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

// ------------------------------------------------------------------ Codex

describe("Codex hook (examples/codex/hq_codex.mjs)", () => {
  const SID = "01a1a55e-5480-7021-9aba-e21b34c5176d"; // UUIDv7 like Codex: starts with a timestamp
  const CWD = "/home/dev/shop-api";
  const cfg = codex.loadConfig({ HQ_ENV_FILE: "/none.env" } as unknown as NodeJS.ProcessEnv);
  const events = (p: Json) => {
    const body = codex.translate({ session_id: SID, cwd: CWD, model: "gpt-5.5", ...p });
    return body ? toEvents("/api/hook", codex.headersFor(cfg, "/api/hook", body), body) : [];
  };
  const main = codex.agentIdFor(SID);

  it("hashes Codex ids, so sessions started in the same minute stay apart", () => {
    const other = "01a1a55e-9999-7021-8888-777777777777";
    expect(codex.agentIdFor(SID)).toMatch(/^cc-[0-9a-f]{8}$/);
    expect(codex.agentIdFor(SID)).not.toBe(codex.agentIdFor(other));
    expect(SID.slice(0, 8)).toBe(other.slice(0, 8)); // what the bridge would have used unhashed
  });

  it("session start, prompt, tools, permission, stop look like Claude Code with a Codex role", () => {
    const start = events({ hook_event_name: "SessionStart", source: "startup", transcript_path: null, permission_mode: "default" });
    expect(start).toEqual([
      expect.objectContaining({ type: "agent_update", id: main, role: "Codex · shop-api", status: "idle", task: "Sesi startup di shop-api · gpt-5.5" }),
    ]);
    expect(start[0].name).toMatch(/^shop-api#[0-9a-f]{4}$/);
    expect(events({ hook_event_name: "UserPromptSubmit", turn_id: "t1", prompt: "deploy token=abc123" })[0]).toMatchObject({ status: "thinking", task: "deploy token=***" });
    expect(events({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } })[0]).toMatchObject({ status: "working", task: "$ npm test" });
    expect(events({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: ["bash", "-lc", "ls -la"] } })[0]).toMatchObject({ task: "$ ls -la" });
    const patch = "*** Begin Patch\n*** Update File: src/cart.py\n@@\n-a\n+b\n*** Add File: src/new.py\n+x\n*** End Patch";
    expect(events({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch } })[0]).toMatchObject({ task: "Edit cart.py (+1)" });
    expect(events({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Add File: a/b.md\n+x" } })[0]).toMatchObject({ task: "Menulis b.md" });
    expect(events({ hook_event_name: "PreToolUse", tool_name: "mcp__github__create_issue", tool_input: {} })[0]).toMatchObject({ task: "MCP github: create_issue" });
    expect(events({ hook_event_name: "PreToolUse", tool_name: "update_plan", tool_input: { plan: [] } })).toHaveLength(1); // quiet: no log line
    expect(events({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf dist", description: "hapus build" } })[0]).toMatchObject({ status: "waiting", task: "Minta izin: $ rm -rf dist" });
    const stop = events({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Selesai, test lulus" });
    expect(stop[0]).toMatchObject({ type: "task_done", id: main, status: "idle" });
    expect(stop[1]).toMatchObject({ type: "log", message: "Selesai: Selesai, test lulus" });
    expect(events({ hook_event_name: "PreCompact", trigger: "auto" })[0]).toMatchObject({ status: "thinking" });
  });

  it("Interrupt waits for the next prompt, SessionEnd goes offline", () => {
    expect(events({ hook_event_name: "Interrupt", turn_id: "t1" })[0]).toMatchObject({ status: "idle", task: "Menunggu prompt berikutnya" });
    expect(events({ hook_event_name: "SessionEnd", reason: "other" })[0]).toMatchObject({ status: "offline", task: "Sesi selesai" });
  });

  it("subagents sit with their session; generic ones get a short suffix", () => {
    const AID = "01a1a560-0000-7000-8000-000000000001";
    const sub = events({ hook_event_name: "SubagentStart", agent_id: AID, agent_type: "default" })[0];
    expect(sub).toMatchObject({ id: codex.agentIdFor(SID, AID), parent: main, role: "Subagen · shop-api", status: "working" });
    expect(sub.name).toMatch(/^subagen#[0-9a-f]{4}$/);
    expect(events({ hook_event_name: "SubagentStart", agent_id: AID, agent_type: "explorer" })[0]).toMatchObject({ name: "explorer" });
    const tool = events({ hook_event_name: "PreToolUse", agent_id: AID, agent_type: "explorer", tool_name: "Bash", tool_input: { command: "rg cart" } })[0];
    expect(tool).toMatchObject({ id: codex.agentIdFor(SID, AID), task: "$ rg cart" });
  });

  it("ignores events without anything to show and odd input", () => {
    expect(codex.translate({ hook_event_name: "PostToolUse", session_id: SID })).toBeNull();
    expect(codex.translate({ hook_event_name: "PreModelRequest", session_id: SID })).toBeNull();
    expect(codex.translate(null)).toBeNull();
    expect(codex.requestsFor("teks")).toEqual([]);
  });

  it("token totals come from the transcript of the session or subagent", () => {
    const dir = tmp();
    const line = (n: number) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: n - 10, cached_input_tokens: 5, output_tokens: 10, total_tokens: n } } } });
    const mainFile = path.join(dir, "rollout-main.jsonl");
    fs.writeFileSync(mainFile, [line(100), "{rusak", line(5276136), JSON.stringify({ type: "response_item" })].join("\n") + "\n");
    const subFile = path.join(dir, "rollout-sub.jsonl");
    fs.writeFileSync(subFile, line(42) + "\n");
    const stop = codex.requestsFor({ hook_event_name: "Stop", session_id: SID, cwd: CWD, transcript_path: mainFile });
    expect(stop[1]).toEqual(["/api/event", { type: "agent_update", id: main, tokens: 5276136 }]);
    const AID = "child-thread";
    const subStop = codex.requestsFor({ hook_event_name: "SubagentStop", session_id: SID, cwd: CWD, agent_id: AID, agent_type: "worker", transcript_path: mainFile, agent_transcript_path: subFile });
    expect(subStop[1]).toEqual(["/api/event", { type: "agent_update", id: codex.agentIdFor(SID, AID), tokens: 42 }]);
    // the id the bridge gives that subagent from the hook request
    expect(toEvents("/api/hook", {}, subStop[0][1] as unknown as Json)[0]).toMatchObject({ id: codex.agentIdFor(SID, AID) });
    expect(codex.transcriptTokens(path.join(dir, "missing.jsonl"))).toBeNull();
    expect(codex.transcriptTokens(path.join(dir, "rollout-main.txt"))).toBeNull();
  });

  it("posts to Agent HQ with the role, token, and env-file settings, printing nothing", async () => {
    const state = tmp();
    const envFile = path.join(state, "agent-hq.env");
    fs.writeFileSync(envFile, `HQ_URL=${hqUrl}/api\nHQ_TEAM=red  # tim\nexport HQ_GROUP="Rilis v2"\n`);
    got.length = 0;
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: SID, cwd: "C:\\Users\\dev\\shop-api", tool_name: "Bash", tool_input: { command: "dir" } });
    const r = await runNode([CODEX], payload, cleanEnv({ HQ_ENV_FILE: envFile, HQ_STATE_DIR: state, HQ_NAME: "Rexx", HQ_TOKEN: "rahasia" }));
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(got).toHaveLength(1);
    expect(got[0].path).toBe("/api/hook");
    expect(got[0].headers).toMatchObject({ authorization: "Bearer rahasia", "x-hq-name": "Rexx", "x-hq-team": "red", "x-hq-group": "Rilis v2" });
    expect(String(got[0].headers["x-hq-role"])).toMatch(/^Codex · /);
    expect(got[0].body).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "dir" } });
  });

  it("stays quiet and fast when Agent HQ is down, then skips for a while", async () => {
    const state = tmp();
    const env = cleanEnv({ HQ_URL: CLOSED, HQ_STATE_DIR: state, HQ_ENV_FILE: "/none.env" });
    const payload = JSON.stringify({ hook_event_name: "Stop", session_id: SID, cwd: CWD });
    const first = await runNode([CODEX], payload, env);
    expect(first).toMatchObject({ code: 0, stdout: "", stderr: "" });
    const down = fs.readdirSync(state).find((f) => f.endsWith(".down"));
    expect(down).toBeTruthy();
    expect(Number(fs.readFileSync(path.join(state, down!), "utf8"))).toBeGreaterThan(Date.now());
    expect((await runNode([CODEX], "bukan json", env)).code).toBe(0);
  });

  it("--test sends a test character and reports the result", async () => {
    got.length = 0;
    const ok = await runNode([CODEX, "--test"], "", cleanEnv({ HQ_URL: hqUrl, HQ_STATE_DIR: tmp(), HQ_ENV_FILE: "/none.env" }));
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('OK: karakter "Tes Codex"');
    expect(got.map((g) => g.body.hook_event_name)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);
    const bad = await runNode([CODEX, "--test"], "", cleanEnv({ HQ_URL: hqUrl, HQ_TOKEN: "salah", HQ_STATE_DIR: tmp(), HQ_ENV_FILE: "/none.env" }));
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("HQ_TOKEN salah?");
    const down = await runNode([CODEX, "--test"], "", cleanEnv({ HQ_URL: CLOSED, HQ_STATE_DIR: tmp(), HQ_ENV_FILE: "/none.env" }));
    expect(down.stdout).toContain("tidak terjangkau");
  });
});

describe("Codex installer (examples/codex/install.mjs)", () => {
  const install = (home: string, ...args: string[]) =>
    spawnSync(process.execPath, [CODEX_INSTALL, "--codex-home", home, "--url", CLOSED, ...args], { encoding: "utf8", env: cleanEnv({}) });
  const ours = (doc: Json) =>
    Object.values((doc.hooks || {}) as Record<string, { hooks: { command: string }[] }[]>)
      .flat()
      .flatMap((g) => g.hooks)
      .filter((h) => h.command.includes("hq_codex.mjs"));

  it("copies the hook, merges hooks.json once per event, keeps other hooks, and uninstalls cleanly", () => {
    const home = tmp();
    const foreign = { type: "command", command: "python3 ~/.codex/guard.py" };
    const file = path.join(home, "hooks.json");
    fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [foreign] }] } }));
    const r1 = install(home);
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain("/hooks");
    expect(fs.existsSync(path.join(home, "agent-hq", "hq_codex.mjs"))).toBe(true);
    expect(fs.readFileSync(path.join(home, "agent-hq", "agent-hq.env"), "utf8")).toContain(`HQ_URL=${CLOSED}`);
    expect(fs.readdirSync(home).some((f) => f.startsWith("hooks.json.agent-hq-") && f.endsWith(".bak"))).toBe(true);
    expect(install(home).status).toBe(0); // second run: replaced, not doubled
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(ours(doc)).toHaveLength(codex.EVENTS.length);
    expect(Object.keys(doc.hooks).sort()).toEqual([...codex.EVENTS].sort());
    expect(doc.hooks.PreToolUse[0]).toEqual({ matcher: "Bash", hooks: [foreign] });
    expect(doc.hooks.SessionEnd[0].hooks[0].timeout).toBeLessThanOrEqual(3);

    expect(install(home, "--uninstall").status).toBe(0);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after).toEqual({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [foreign] }] } });
    expect(fs.existsSync(path.join(home, "agent-hq"))).toBe(false);
  });

  it("refuses a broken hooks.json without touching it, and --print changes nothing", () => {
    const home = tmp();
    fs.writeFileSync(path.join(home, "hooks.json"), "{ rusak");
    const r = install(home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("bukan JSON yang valid");
    expect(fs.readFileSync(path.join(home, "hooks.json"), "utf8")).toBe("{ rusak");
    expect(fs.existsSync(path.join(home, "agent-hq"))).toBe(false);
    const empty = tmp();
    const p = install(empty, "--print");
    expect(ours(JSON.parse(p.stdout))).toHaveLength(codex.EVENTS.length);
    expect(fs.readdirSync(empty)).toEqual([]);
  });

  it("warns when config.toml turns hooks off", () => {
    const home = tmp();
    fs.writeFileSync(path.join(home, "config.toml"), 'model = "gpt-5.5"\n\n[features]\nhooks = false\n');
    expect(install(home).stdout).toContain("PERINGATAN");
  });
});

// ------------------------------------------------------------------ Claude Code installer

describe("Claude Code installer (examples/claude/install.mjs)", () => {
  const example = JSON.parse(fs.readFileSync(path.join(EX, "claude-hooks.settings.json"), "utf8"));
  const install = (file: string, ...args: string[]) =>
    spawnSync(process.execPath, [CLAUDE_INSTALL, "--settings", file, ...args], { encoding: "utf8", env: cleanEnv({}) });
  const ourCount = (doc: Json) =>
    Object.values((doc.hooks || {}) as Record<string, { hooks: { type: string; url?: string }[] }[]>)
      .flat()
      .flatMap((g) => g.hooks)
      .filter((h) => h.type === "http" && /\/api\/hook$/.test(h.url || "")).length;

  it("merges into existing settings once, keeps everything else, and uninstalls only its hooks", () => {
    const dir = tmp();
    const file = path.join(dir, "settings.json");
    const foreign = { type: "command", command: "npx prettier --write" };
    const oldOurs = { type: "http", url: "http://127.0.0.1:8787/hook", headers: { "X-HQ-Name": "$HQ_NAME" } };
    fs.writeFileSync(file, JSON.stringify({ model: "opus", permissions: { allow: ["Bash(npm test)"] }, hooks: { Stop: [{ hooks: [foreign] }, { hooks: [oldOurs] }] } }));
    expect(install(file, "--url", CLOSED).status).toBe(0);
    expect(install(file, "--url", CLOSED).stdout).toContain("tidak berubah");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(doc.model).toBe("opus");
    expect(doc.permissions).toEqual({ allow: ["Bash(npm test)"] });
    expect(ourCount(doc)).toBe(Object.keys(example.hooks).length);
    expect(doc.hooks.Stop[0]).toEqual({ hooks: [foreign] });
    expect(JSON.stringify(doc)).not.toContain("8787/hook\""); // the old-style hook was replaced
    expect(doc.hooks.SessionStart[0].hooks[0].url).toBe(`${CLOSED}/api/hook`);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".bak"))).toHaveLength(1);

    expect(install(file, "--uninstall").status).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ model: "opus", permissions: { allow: ["Bash(npm test)"] }, hooks: { Stop: [{ hooks: [foreign] }] } });
  });

  it("creates a missing settings file, refuses broken JSON, and --print shows only the hooks", () => {
    const dir = tmp();
    const file = path.join(dir, "sub", "settings.json");
    expect(install(file, "--url", CLOSED).status).toBe(0);
    expect(ourCount(JSON.parse(fs.readFileSync(file, "utf8")))).toBe(Object.keys(example.hooks).length);
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{ rusak");
    expect(install(broken).status).toBe(1);
    expect(fs.readFileSync(broken, "utf8")).toBe("{ rusak");
    const secret = path.join(dir, "secret.json");
    fs.writeFileSync(secret, JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-rahasia" } }));
    const p = install(secret, "--print");
    expect(p.stdout).not.toContain("sk-ant-rahasia");
    expect(Object.keys(JSON.parse(p.stdout))).toEqual(["hooks"]);
  });
});

// ------------------------------------------------------------------ OpenCode

describe("OpenCode plugin (examples/opencode/agent-hq.js)", () => {
  const DIR = "/home/dev/shop-api";
  const MAIN = "ses_7a1b2c3d4e5fXyZmainSession01";
  const CHILD = "ses_7a1b2c3d4e60AbCchildSession1";

  /* eslint-disable @typescript-eslint/no-explicit-any -- OpenCode hook inputs are loosely typed */
  async function plugin(env: Record<string, string> = {}) {
    for (const k of ["HQ_NAME", "HQ_ROLE", "HQ_TEAM", "HQ_GROUP", "HQ_TOKEN", "HQ_DISABLE"]) vi.stubEnv(k, "");
    vi.stubEnv("HQ_URL", hqUrl);
    vi.stubEnv("HQ_ENV_FILE", "/none.env");
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    got.length = 0;
    return (await AgentHQ({ directory: DIR, worktree: DIR })) as unknown as Record<string, (...a: any[]) => Promise<void>>;
  }
  const ev = (type: string, properties: Json) => ({ event: { type, properties } });
  const prompt = (sessionID: string, text: string) => [
    { sessionID, agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-5" }, messageID: "msg_u1" },
    { message: { id: "msg_u1" }, parts: [{ type: "text", text }, { type: "text", text: "isi file", synthetic: true }] },
  ];
  const names = () => got.map((g) => (g.path === "/api/hook" ? g.body.hook_event_name : `event:${g.body.type}`));
  const broadcast = () => got.flatMap((g) => toEvents(g.path, g.headers as Json, g.body));
  afterEach(() => vi.unstubAllEnvs());

  it("a full turn with permission, a subagent, a failed tool, and tokens", async () => {
    const h = await plugin({ HQ_TEAM: "blue" });
    await h["chat.message"](...prompt(MAIN, "perbaiki test token=abc123"));
    await h["tool.execute.before"]({ tool: "bash", sessionID: MAIN, callID: "c1" }, { args: { command: "npm test", description: "run" } });
    await h.event(ev("permission.asked", { id: "per_1", sessionID: MAIN, permission: "bash", patterns: ["rm -rf dist"], metadata: {}, always: [] }));
    await h.event(ev("permission.asked", { id: "per_1", sessionID: MAIN, permission: "bash", patterns: ["rm -rf dist"], metadata: {}, always: [] }));
    await h.event(ev("permission.replied", { sessionID: MAIN, requestID: "per_1", reply: "once" }));
    await h["tool.execute.before"]({ tool: "task", sessionID: MAIN, callID: "c2" }, { args: { description: "Cek test", prompt: "...", subagent_type: "explore" } });
    await h.event(ev("session.created", { info: { id: CHILD, parentID: MAIN, title: "Cek test (@explore subagent)", directory: DIR } }));
    await h["tool.execute.before"]({ tool: "read", sessionID: CHILD, callID: "c3" }, { args: { filePath: `${DIR}/src/cart.ts` } });
    const failed = ev("message.part.updated", { part: { type: "tool", sessionID: MAIN, messageID: "m2", callID: "c1", tool: "bash", state: { status: "error", error: "exit code 1", input: { command: "npm test" } } } });
    await h.event(failed);
    await h.event(failed);
    await h.event(ev("session.idle", { sessionID: CHILD }));
    await h.event(ev("message.updated", { info: { id: "msg_a1", sessionID: MAIN, role: "assistant", tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 10 } } } }));
    await h.event(ev("message.part.updated", { part: { type: "text", sessionID: MAIN, messageID: "msg_a1", text: "Semua test lulus" } }));
    await h.event(ev("session.status", { sessionID: MAIN, status: { type: "idle" } }));
    await h.event(ev("session.idle", { sessionID: MAIN })); // the same end, reported twice
    await until(() => got.length >= 12);
    await new Promise((r) => setTimeout(r, 50));

    expect(names()).toEqual([
      "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "event:agent_update",
      "PreToolUse", "SubagentStart", "PreToolUse", "PostToolUseFailure", "SubagentStop", "Stop", "event:agent_update",
    ]);
    const out = broadcast();
    const mainId = out[0].id as string;
    expect(out[0]).toMatchObject({ role: "OpenCode · shop-api", team: "blue", status: "idle", task: "Sesi baru di shop-api · anthropic/claude-sonnet-5" });
    expect(out[0].name).toMatch(/^shop-api#[0-9a-f]{4}$/);
    expect(mainId).toMatch(/^cc-[0-9a-f]{8}$/);
    const tasks = out.filter((e) => e.type === "agent_update" && e.id === mainId).map((e) => e.task).filter(Boolean);
    expect(tasks).toEqual(expect.arrayContaining(["perbaiki test token=***", "$ npm test", "Minta izin: $ rm -rf dist", "Izin diberikan, lanjut kerja", "Delegasi: Cek test"]));
    const sub = out.find((e) => e.type === "agent_update" && e.parent === mainId);
    expect(sub).toMatchObject({ name: "explore", role: "Subagen · shop-api", status: "working" });
    expect(out).toContainEqual(expect.objectContaining({ id: sub!.id, task: "Baca cart.ts" }));
    expect(out).toContainEqual(expect.objectContaining({ type: "log", level: "warn", message: "Bash gagal: exit code 1" }));
    expect(out).toContainEqual(expect.objectContaining({ type: "task_done", id: sub!.id }));
    expect(out).toContainEqual(expect.objectContaining({ type: "task_done", id: mainId }));
    expect(out).toContainEqual(expect.objectContaining({ type: "log", message: "Selesai: Semua test lulus" }));
    expect(out.at(-1)).toEqual({ type: "agent_update", id: mainId, tokens: 1135 });

    await h.dispose();
    expect(names().at(-1)).toBe("SessionEnd");
  });

  it("an aborted turn and a refused permission end without confetti", async () => {
    const h = await plugin();
    await h["chat.message"](...prompt(MAIN, "hapus folder build"));
    await h.event(ev("session.error", { sessionID: MAIN, error: { name: "MessageAbortedError", data: { message: "Aborted" } } }));
    await h.event(ev("session.idle", { sessionID: MAIN }));
    await h["chat.message"](...prompt(MAIN, "coba lagi"));
    await h.event(ev("permission.asked", { id: "per_2", sessionID: MAIN, permission: "edit", patterns: ["src/a.ts"], metadata: { filepath: "src/a.ts" }, always: [] }));
    await h.event(ev("permission.replied", { sessionID: MAIN, requestID: "per_2", reply: "reject" }));
    await h.event(ev("message.part.updated", { part: { type: "tool", sessionID: MAIN, messageID: "m3", callID: "c9", tool: "edit", state: { status: "error", error: "The user rejected permission to use this specific tool call." } } }));
    await h.event(ev("session.idle", { sessionID: MAIN }));
    await h.event(ev("session.error", { sessionID: MAIN, error: { name: "APIError", data: { message: "Rate limit tercapai" } } }));
    await until(() => got.length >= 9);
    await new Promise((r) => setTimeout(r, 50));
    expect(names()).toEqual([
      "SessionStart", "UserPromptSubmit", "Notification", "UserPromptSubmit", "PermissionRequest",
      "PermissionDenied", "event:agent_update", "Notification", "StopFailure",
    ]);
    const out = broadcast();
    expect(out.some((e) => e.type === "task_done")).toBe(false);
    expect(out).toContainEqual(expect.objectContaining({ task: "Minta izin: Edit a.ts" }));
    expect(out).toContainEqual(expect.objectContaining({ type: "log", message: "Izin ditolak: Edit" }));
    expect(out).toContainEqual(expect.objectContaining({ status: "idle", task: "Menunggu prompt berikutnya" }));
    expect(out).toContainEqual(expect.objectContaining({ status: "error" }));
  });

  it("questions wait for you; retries are logged once per attempt", async () => {
    const h = await plugin();
    await h["chat.message"](...prompt(MAIN, "rilis"));
    await h.event(ev("question.asked", { id: "q1", sessionID: MAIN, questions: [{ header: "Versi", question: "Naikkan ke versi berapa?", options: [] }] }));
    await h.event(ev("question.replied", { sessionID: MAIN, requestID: "q1", answers: [["2.3"]] }));
    const retry = ev("session.status", { sessionID: MAIN, status: { type: "retry", attempt: 1, message: "Overloaded", next: 0 } });
    await h.event(retry);
    await h.event(retry);
    await until(() => got.length >= 5);
    await new Promise((r) => setTimeout(r, 50));
    const out = broadcast();
    expect(out).toContainEqual(expect.objectContaining({ status: "waiting", task: "Naikkan ke versi berapa?" }));
    expect(out).toContainEqual(expect.objectContaining({ status: "thinking", task: "Lanjut setelah jawabanmu" }));
    expect(out.filter((e) => e.type === "log" && e.message === "Coba lagi (1): Overloaded")).toHaveLength(1);
  });

  it("never throws, never waits for Agent HQ, and HQ_DISABLE turns it off", async () => {
    const h = await plugin({ HQ_URL: CLOSED });
    for (const bad of [undefined, {}, { event: null }, { event: { type: "session.created" } }, { event: { type: "session.status", properties: { status: null } } }]) {
      await expect(h.event(bad)).resolves.toBeUndefined();
    }
    await expect(h["tool.execute.before"](undefined, undefined)).resolves.toBeUndefined();
    await expect(h["chat.message"]({ sessionID: MAIN }, null)).resolves.toBeUndefined();
    const t0 = Date.now();
    for (let k = 0; k < 50; k++) await h["tool.execute.before"]({ tool: "bash", sessionID: MAIN, callID: `x${k}` }, { args: { command: "ls" } });
    expect(Date.now() - t0).toBeLessThan(500);
    await h.dispose();

    expect(await plugin({ HQ_DISABLE: "1" })).toEqual({});
  });
});
