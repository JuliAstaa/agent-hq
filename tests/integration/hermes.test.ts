// Hermes Agent adapters (examples/hermes, docs/hermes.md). The shell hook's Hermes -> Claude Code translation
// is checked through the bridge's own translator (hookToEvents), the MCP server over stdio against a fake
// Agent HQ, the Python redaction against lib/bridge/redact.ts, and the installer on a sample config.yaml.
// Skipped when no Python 3 is installed.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hookToEvents } from "@/lib/bridge/hooks";
import { redact } from "@/lib/bridge/redact";

const DIR = path.resolve(__dirname, "../../examples/hermes");
const HOOK = path.join(DIR, "hq_hook.py");

function findPython(): string | null {
  for (const cmd of ["python3", "python"]) {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (r.status === 0 && /Python 3\.\d+/.test(`${r.stdout}${r.stderr}`)) return cmd;
  }
  return null;
}
const PY = findPython() ?? "python3";
const suite = findPython() ? describe : describe.skip;

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hq-hermes-"));

/** The test's environment without the developer's own HQ_* settings. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" };
  for (const k of Object.keys(env)) if (k.startsWith("HQ_")) delete env[k];
  return Object.assign(env, extra);
}

type Req = { path: string; headers: Record<string, string>; body: Record<string, unknown> };

/** Run hq_hook.py --dry-run for one Hermes event. */
function hermesHook(state: string, payload: Record<string, unknown>, env: Record<string, string> = {}): Req[] {
  const r = spawnSync(PY, [HOOK, "--dry-run"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: cleanEnv({ HQ_STATE_DIR: state, HQ_ENV_FILE: path.join(state, "none.env"), ...env }),
  });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Req);
}

/** Requests -> what Agent HQ broadcasts: /api/hook bodies go through the bridge's translator. */
function toEvents(reqs: Req[]): Record<string, unknown>[] {
  return reqs.flatMap((r) => {
    if (r.path !== "/api/hook") return [r.body];
    const h = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
    return hookToEvents(r.body, (n) => h[n], () => {});
  });
}

const SID = "20261103_101500_a1b2c3";
const CWD = "/home/dev/shop-api";
const ID = `cc-${sha1(SID).slice(0, 8)}`;
const subId = (key: string) => `cc-${sha1(SID).slice(0, 6)}-${sha1(key).slice(0, 8)}`;

suite("Hermes shell hook (hq_hook.py)", { timeout: 30_000 }, () => {
  const session = (state: string) => (payload: Record<string, unknown>, env?: Record<string, string>) =>
    toEvents(hermesHook(state, { session_id: SID, cwd: CWD, ...payload }, env));

  it("a Hermes session plays out like a Claude Code session", () => {
    const run = session(tmp());
    expect(run({ hook_event_name: "on_session_start", extra: { model: "hermes-4-405b" } })).toEqual([
      { type: "agent_update", id: ID, name: `shop-api#${sha1(SID).slice(0, 4)}`, role: "Hermes · shop-api", source: "claude-code", status: "idle", task: "Sesi baru di shop-api · hermes-4-405b" },
    ]);
    // the first prompt does not repeat SessionStart; the bridge redacts it
    expect(run({ hook_event_name: "pre_llm_call", extra: { user_message: "perbaiki test, token=abc123", is_first_turn: true } })).toEqual([
      expect.objectContaining({ type: "agent_update", id: ID, status: "thinking", task: "perbaiki test, token=***" }),
      expect.objectContaining({ type: "log", id: ID, message: "Prompt baru masuk" }),
    ]);
    expect(run({ hook_event_name: "pre_tool_call", tool_name: "terminal", tool_input: { command: "npm test" } })).toEqual([
      expect.objectContaining({ id: ID, status: "working", task: "$ npm test" }),
      expect.objectContaining({ type: "log", message: "Bash: $ npm test" }),
    ]);
    expect(run({ hook_event_name: "pre_tool_call", tool_name: "read_file", tool_input: { path: `${CWD}/src/app.py` } })).toEqual([
      expect.objectContaining({ status: "working", task: "Baca app.py" }),
    ]);
    expect(run({ hook_event_name: "pre_tool_call", tool_name: "patch", tool_input: { mode: "patch", patch: "*** Begin Patch\n*** Update File: src/cart.py\n@@" } })).toEqual([
      expect.objectContaining({ task: "Edit cart.py" }),
      expect.objectContaining({ type: "log", message: "Edit: Edit cart.py" }),
    ]);
    expect(run({ hook_event_name: "post_tool_call", tool_name: "terminal", extra: { result: JSON.stringify({ output: "2 failed", exit_code: 1 }) } })).toEqual([
      expect.objectContaining({ type: "log", level: "warn", message: "Bash gagal: exit code 1" }),
    ]);
    expect(run({ hook_event_name: "post_tool_call", tool_name: "terminal", extra: { result: JSON.stringify({ output: "ok", exit_code: 0, error: null }) } })).toEqual([]);
    // our own MCP tools are reported by hq_mcp.py, not as "working"
    expect(run({ hook_event_name: "pre_tool_call", tool_name: "mcp_agent_hq_hq_status", tool_input: { status: "working" } })).toEqual([]);
    expect(run({ hook_event_name: "pre_approval_request", extra: { command: "rm -rf build", description: "recursive delete" } })).toEqual([
      expect.objectContaining({ status: "waiting", task: "Minta izin: $ rm -rf build" }),
      expect.objectContaining({ type: "log", level: "warn", message: "Menunggu izin untuk Bash" }),
    ]);
    expect(run({ hook_event_name: "post_approval_response", extra: { command: "rm -rf build", choice: "deny" } })).toEqual([
      { type: "log", id: ID, level: "warn", message: "Izin ditolak: Bash" },
      { type: "agent_update", id: ID, status: "thinking", task: "Izin ditolak, mencari cara lain" },
    ]);
    expect(run({ hook_event_name: "on_human_input_request", extra: { kind: "clarify", prompt: "Pakai Postgres atau SQLite?" } })).toEqual([
      expect.objectContaining({ status: "waiting", task: "Pakai Postgres atau SQLite?" }),
      expect.objectContaining({ type: "log", level: "warn" }),
    ]);
    expect(run({ hook_event_name: "post_llm_call", extra: { assistant_response: "Test hijau lagi" } })).toEqual([
      expect.objectContaining({ type: "task_done", id: ID, status: "idle" }),
      expect.objectContaining({ type: "log", message: "Selesai: Test hijau lagi" }),
    ]);
    expect(run({ hook_event_name: "on_session_end", extra: { completed: true, interrupted: false } })).toEqual([]);
    expect(run({ hook_event_name: "on_session_end", extra: { completed: false, interrupted: true } })).toEqual([
      expect.objectContaining({ status: "idle", task: "Menunggu prompt berikutnya" }),
    ]);
    // quitting: no session id in the event, the Hermes process remembers it
    expect(run({ hook_event_name: "on_session_finalize", session_id: null })).toEqual([
      expect.objectContaining({ id: ID, status: "offline", task: "Sesi selesai" }),
    ]);
  });

  it("a subagent gets its own character, named after its goal, and leaves on subagent_stop", () => {
    const run = session(tmp());
    run({ hook_event_name: "on_session_start" });
    const SUB = subId("sa-1");
    expect(run({ hook_event_name: "subagent_start", session_id: null, extra: { parent_session_id: SID, child_session_id: "child-77", child_subagent_id: "sa-1", child_role: "leaf", child_goal: "cari bug di keranjang" } })).toEqual([
      // parent: the main character (meeting floor, prd.md §7.9)
      { type: "agent_update", id: SUB, name: "cari bug di keran…", role: "Subagen · shop-api", parent: ID, source: "claude-code", status: "working", task: "Subagen cari bug di keranjang mulai" },
    ]);
    expect(run({ hook_event_name: "pre_tool_call", session_id: "child-77", tool_name: "search_files", tool_input: { pattern: "TODO", target: "content" } })).toEqual([
      expect.objectContaining({ id: SUB, status: "working", task: 'Cari "TODO"' }),
    ]);
    // the subagent's own end of turn is not the main agent's
    expect(run({ hook_event_name: "post_llm_call", session_id: "child-77", extra: { assistant_response: "x" } })).toEqual([]);
    // no ids in subagent_stop: matched by parent and role
    expect(run({ hook_event_name: "subagent_stop", session_id: null, extra: { parent_session_id: SID, child_role: "leaf", child_status: "failed", child_summary: "timeout di API" } })).toEqual([
      { type: "log", id: SUB, level: "warn", message: "Subagen cari bug di keranjang: failed" },
      expect.objectContaining({ type: "task_done", id: SUB }),
      expect.objectContaining({ type: "log", id: SUB, message: "Selesai: timeout di API" }),
    ]);
  });

  it("an unknown session while a subagent runs is that subagent; the parent's answer stops leftovers", () => {
    const run = session(tmp());
    run({ hook_event_name: "pre_llm_call", extra: { user_message: "riset harga" } });
    run({ hook_event_name: "subagent_start", extra: { parent_session_id: SID, child_subagent_id: "sa-9", child_role: "researcher" } });
    const SUB = subId("sa-9");
    const evs = run({ hook_event_name: "pre_tool_call", session_id: "20261103_101502_ffffff", tool_name: "web_search", tool_input: { query: "harga gpu" } });
    expect(evs[0]).toMatchObject({ id: SUB, name: "researcher", status: "working", task: "Search: harga gpu" });
    expect(run({ hook_event_name: "post_llm_call", extra: { assistant_response: "beres" } })).toEqual([
      expect.objectContaining({ type: "task_done", id: ID }),
      expect.objectContaining({ type: "log", id: ID, message: "Selesai: beres" }),
      expect.objectContaining({ type: "task_done", id: SUB }),
    ]);
  });

  it("HQ_NAME, HQ_ROLE, HQ_TEAM become headers; sessions started in the same second stay apart", () => {
    const state = tmp();
    const a = toEvents(hermesHook(state, { hook_event_name: "on_session_start", session_id: "20261103_101500_aaaaaa", cwd: CWD }, { HQ_NAME: "Rexx", HQ_ROLE: "Pentester", HQ_TEAM: "red" }));
    const b = toEvents(hermesHook(state, { hook_event_name: "on_session_start", session_id: "20261103_101500_bbbbbb", cwd: CWD }));
    expect(a[0]).toMatchObject({ name: "Rexx", role: "Pentester", team: "red" });
    expect(a[0].id).not.toBe(b[0].id);
  });

  it("never disturbs Hermes: bad input is ignored, Agent HQ down means silence and a pause", () => {
    const state = tmp();
    const env = cleanEnv({ HQ_STATE_DIR: state, HQ_ENV_FILE: path.join(state, "none.env"), HQ_URL: "http://127.0.0.1:9", HQ_TIMEOUT: "0.5" });
    const bad = spawnSync(PY, [HOOK], { input: "not json", encoding: "utf8", env });
    expect([bad.status, bad.stdout, bad.stderr]).toEqual([0, "", ""]);
    const send = () => spawnSync(PY, [HOOK], { input: JSON.stringify({ hook_event_name: "pre_tool_call", session_id: SID, tool_name: "terminal", tool_input: { command: "ls" } }), encoding: "utf8", env });
    const first = send();
    expect([first.status, first.stdout]).toEqual([0, ""]);
    expect(first.stderr).toContain("tidak terjangkau");
    const second = send(); // paused for 20 s: not even a connection attempt
    expect([second.status, second.stdout, second.stderr]).toEqual([0, "", ""]);
  });
});

type Rpc = {
  id: number;
  result?: { protocolVersion?: string; isError?: boolean; content?: { type: string; text: string }[]; tools?: { name: string }[] };
  error?: { code: number; message: string };
};

function startMcp(env: Record<string, string>) {
  const child = spawn(PY, [path.join(DIR, "hq_mcp.py")], { env: cleanEnv(env), stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (msg: Rpc) => void>();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line) as Rpc;
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  let next = 1;
  const send = (obj: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\n");
  return {
    call: (method: string, params?: object) =>
      new Promise<Rpc>((resolve) => {
        const id = next++;
        waiting.set(id, resolve);
        send({ id, method, params });
      }),
    notify: (method: string) => send({ method }),
    close: () =>
      new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
        child.stdin.end();
      }),
  };
}

suite("Agent HQ MCP server (hq_mcp.py)", { timeout: 30_000 }, () => {
  let server: http.Server;
  let url = "";
  const got: { path: string; body: unknown }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        got.push({ path: req.url || "", body: JSON.parse(data || "null") });
        res.writeHead(202, { "content-type": "application/json" }).end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("handshake, tools, and its own character when no hook runs in the same process", async () => {
    const state = tmp();
    got.length = 0;
    const mcp = startMcp({ HQ_URL: url, HQ_STATE_DIR: state, HQ_ENV_FILE: path.join(state, "none.env"), HQ_NAME: "Sentra", HQ_TEAM: "blue" });
    const init = await mcp.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "agent-hq" }, capabilities: { tools: {} } });
    mcp.notify("notifications/initialized");
    expect((await mcp.call("tools/list")).result?.tools?.map((t) => t.name)).toEqual(["hq_status", "hq_log", "hq_done", "hq_finding", "hq_alert", "hq_metric"]);

    const alert = await mcp.call("tools/call", { name: "hq_alert", arguments: { message: "Bruteforce SSH, password=hunter2", severity: "critical", source_ip: "103.94.12.7" } });
    expect(alert.result).toEqual({ content: [{ type: "text", text: "Reported to Agent HQ." }], isError: false });
    const own = expect.stringMatching(/^hm-[0-9a-f]{8}$/);
    expect(got).toEqual([{ path: "/api/event", body: [
      { type: "agent_update", id: own, status: "working", name: "Sentra", role: expect.stringMatching(/^MCP · /), team: "blue" },
      { type: "alert", id: own, severity: "critical", message: "Bruteforce SSH, password=***", source_ip: "103.94.12.7" },
    ] }]);

    const bad = await mcp.call("tools/call", { name: "hq_finding", arguments: {} });
    expect(bad.result).toMatchObject({ isError: true, content: [{ text: "'title' is required." }] });
    expect((await mcp.call("resources/list")).error).toMatchObject({ code: -32601 });
    expect(got).toHaveLength(1);

    expect(await mcp.close()).toBe(0);
    expect(got[got.length - 1]).toEqual({ path: "/api/event", body: [{ type: "agent_update", id: own, status: "offline", task: "Sesi selesai" }] });
  });

  it("reports for the hook character of the same Hermes process", async () => {
    const state = tmp();
    // What hq_hook.py records. This test process plays Hermes, the parent of both scripts.
    fs.writeFileSync(path.join(state, "hermes-state.json"), JSON.stringify({ procs: { [process.pid]: { sid: SID, id: ID, at: Date.now() / 1000 } } }));
    got.length = 0;
    const mcp = startMcp({ HQ_URL: url, HQ_STATE_DIR: state, HQ_ENV_FILE: path.join(state, "none.env"), HQ_NAME: "ignored" });
    expect((await mcp.call("initialize", {})).result?.protocolVersion).toBe("2025-06-18");
    await mcp.call("tools/call", { name: "hq_finding", arguments: { title: "SQL injection di /login", severity: "high", target: "shop.local" } });
    await mcp.call("tools/call", { name: "hq_status", arguments: { status: "working", task: "Scan port", progress: 0.4 } });
    await mcp.call("tools/call", { name: "hq_done", arguments: { summary: "3 temuan" } });
    await mcp.call("tools/call", { name: "hq_metric", arguments: { value: 37 } });
    expect(got.map((g) => g.body)).toEqual([
      [{ type: "finding", id: ID, severity: "high", title: "SQL injection di /login (shop.local)" }],
      [{ type: "agent_update", id: ID, status: "working", task: "Scan port", progress: 0.4 }],
      // with hooks, Hermes' own end of turn celebrates; hq_done only logs
      [{ type: "log", id: ID, level: "info", message: "Selesai: 3 temuan" }],
      [{ type: "metric", name: "failed_logins", value: 37 }],
    ]);
    await mcp.close();
    expect(got).toHaveLength(4); // no offline event for the hook character
  });
});

suite("Python redaction (hq_common.py)", { timeout: 30_000 }, () => {
  it("matches lib/bridge/redact.ts", () => {
    const inputs = [
      "curl -H 'Authorization: Bearer abc.def-123' x", "bearer eyJhbGciOi.J9.x+y/z=", "https://x.io/?token=abc123&x=1",
      "export API_KEY=sk-live-123", "api-key: 'quoted secret here'", 'password="hunter 2" next', "passwd=pw pwd=pw2",
      "SECRET: s3cr3t", "use sk-ant-REDACTEDREDACTED01 now", "ghp_abcdefghijklmnop1234", "xoxb-1234567890-abc", "gho_shortkey",
      "mysqldump -pXYZ db | mysql x", "grep -pfoo file", "mysql -u root -pS3cret db", "mysqldump -uroot -p'my pass' shop > dump.sql",
      "mariadb-dump -u app -pX9 db", "mysql -pA; mysql -pB", "curl -u admin:hunter2 https://h/api", "curl --user=admin:hunter2 https://h",
      "curl -u 'admin:p w' https://h", "curl -x proxy:3128 -U bob:pr0xy https://h", "git clone https://bob:ghs_tok3n@github.com/x/y.git",
      "psql postgres://admin:s3cr3t@db:5432/app", "sshpass -p 'S3cret' ssh root@10.0.0.5", "sshpass -pS3cret scp a b:/tmp",
      "mysql -u root -p shop", "mysql -h db -P 3306 -u app shop", "curl -u alice https://h", "ssh -p 2222 user@host",
      "TOKEN=a1 curl -H 'authorization: Bearer zz9' https://h/?api_key=k&secret=s ghp_0123456789abcdef", "nothing secret here",
    ];
    const r = spawnSync(PY, [path.join(DIR, "hq_common.py"), "redact"], { input: JSON.stringify(inputs), encoding: "utf8", env: cleanEnv({}) });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(inputs.map((s) => redact(s)));
  });
});

suite("installer (install.py)", { timeout: 30_000 }, () => {
  it("merges into an existing config.yaml, keeps everything else, and is safe to run twice", () => {
    const home = tmp();
    const config = path.join(home, "config.yaml");
    const before = [
      "model:", "  default: hermes-4", "",
      "hooks:", "  pre_tool_call:", '    - command: "/home/u/guard.sh"', "",
      "mcp_servers:", "  github:", '    command: "npx"', "",
      "display:", "  skin: default", "",
    ].join("\n");
    fs.writeFileSync(config, before);
    const install = () => spawnSync(PY, [path.join(DIR, "install.py"), "--hermes-home", home, "--url", "http://127.0.0.1:9"], { encoding: "utf8", env: cleanEnv({}) });

    const first = install();
    expect(first.status).toBe(0);
    const text = fs.readFileSync(config, "utf8");
    expect(text.startsWith(before.trimEnd().split("\n\nmcp_servers:")[0])).toBe(true);
    expect(text).toContain('  github:\n    command: "npx"');
    expect(text).toContain("display:\n  skin: default");
    expect(text.match(/hq_hook\.py/g)).toHaveLength(12); // pre_tool_call already has a hook: merge by hand
    expect(first.stdout).toMatch(/Gabungkan ini[\s\S]*pre_tool_call:/);
    expect(text).toMatch(/^ {2}agent_hq:$/m);
    expect(fs.readdirSync(home).some((f) => /^config\.yaml\.agent-hq-\d{8}-\d{6}\.bak$/.test(f))).toBe(true);
    for (const f of ["hq_common.py", "hq_hook.py", "hq_mcp.py"]) expect(fs.existsSync(path.join(home, "agent-hq", f))).toBe(true);
    expect(fs.readFileSync(path.join(home, "agent-hq", "agent-hq.env"), "utf8")).toMatch(/^HQ_URL=http:\/\/127\.0\.0\.1:9$/m);

    const second = install();
    expect(second.status).toBe(0);
    expect(fs.readFileSync(config, "utf8")).toBe(text);
    expect(second.stdout).toMatch(/hook\s+: sudah terpasang/);
    expect(second.stdout).toMatch(/MCP\s+: sudah terpasang/);
  });

  it("--chat turns on the API server and points Agent HQ at it, keeping keys and other settings", () => {
    const home = tmp();
    const hq = tmp();
    fs.writeFileSync(path.join(hq, "package.json"), '{\n  "name": "agent-hq",\n  "version": "0.1.0"\n}\n');
    fs.writeFileSync(path.join(hq, ".env.local"), "HQ_TOKEN=abc\n");
    const envFile = path.join(home, ".env");
    fs.writeFileSync(envFile, "OPENROUTER_API_KEY=sk-or-rahasia\nAPI_SERVER_PORT=9642\n");
    const install = () =>
      spawnSync(PY, [path.join(DIR, "install.py"), "--hermes-home", home, "--chat", "--no-hooks", "--no-mcp", "--no-cron", "--agent-hq-dir", hq, "--url", "http://127.0.0.1:9"], {
        encoding: "utf8",
        env: cleanEnv({}),
      });

    const first = install();
    expect(first.status).toBe(0);
    const env = fs.readFileSync(envFile, "utf8");
    expect(env).toMatch(/^OPENROUTER_API_KEY=sk-or-rahasia$/m);
    expect(env).toMatch(/^API_SERVER_ENABLED=true$/m);
    const key = env.match(/^API_SERVER_KEY=([0-9a-f]{64})$/m)?.[1];
    expect(key).toBeTruthy();
    const local = fs.readFileSync(path.join(hq, ".env.local"), "utf8");
    expect(local).toMatch(/^HQ_TOKEN=abc$/m);
    expect(local).toMatch(/^HQ_HERMES_API_URL=http:\/\/127\.0\.0\.1:9642$/m);
    expect(local).toContain(`HQ_HERMES_API_KEY=${key}`);
    expect(first.stdout).not.toContain(key!); // never printed
    expect(first.stdout).toMatch(/hermes gateway restart/);
    expect(fs.readdirSync(home).some((f) => /^\.env\.agent-hq-\d{8}-\d{6}\.bak$/.test(f))).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);

    const second = install();
    expect(second.status).toBe(0);
    expect(fs.readFileSync(envFile, "utf8")).toBe(env);
    expect(fs.readFileSync(path.join(hq, ".env.local"), "utf8")).toBe(local);
    expect(second.stdout).toMatch(/sudah aktif/);
    expect(second.stdout).toMatch(/sudah cocok/);
    expect(second.stdout).not.toMatch(/gateway restart/);
  });

  it("refuses a missing Hermes folder", () => {
    const r = spawnSync(PY, [path.join(DIR, "install.py"), "--hermes-home", path.join(tmp(), "nope")], { encoding: "utf8", env: cleanEnv({}) });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Pasang Hermes dulu");
  });
});

/** A Hermes home with two cron jobs, a fresh ticker heartbeat, and executions.db (one live run, one stuck claim). */
function fakeHermesHome(): string {
  const home = tmp();
  fs.mkdirSync(path.join(home, "cron"));
  fs.writeFileSync(path.join(home, "cron", "jobs.json"), JSON.stringify({
    jobs: [
      { id: "a1b2c3d4e5f6", name: "Laporan harian token=abc123", prompt: "RAHASIA jangan dikirim", schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" }, schedule_display: "0 9 * * *", enabled: true, state: "scheduled", next_run_at: "2026-11-04T09:00:00+08:00", last_run_at: "2026-11-03T09:00:02+08:00", last_status: "ok", failure_streak: 0, deliver: "telegram:-100123456" },
      { id: "0f9e8d7c6b5a", name: "Cek SSH", prompt: "x", schedule: { kind: "interval", minutes: 30, display: "every 30m" }, enabled: false, state: "paused", next_run_at: null, last_run_at: "2026-11-03T12:30:00", last_status: "error", last_error: "API key sk-abcdefghijklmnop invalid", failure_streak: 3, deliver: "local" },
    ],
    updated_at: "2026-11-03T12:00:00+08:00",
  }));
  fs.writeFileSync(path.join(home, "cron", "ticker_heartbeat"), `${Date.now() / 1000} 1234`);
  const r = spawnSync(PY, ["-c", [
    "import sqlite3, sys",
    "c = sqlite3.connect(sys.argv[1])",
    "c.execute('create table executions (id text primary key, job_id text, status text, claimed_at text, progress_at text)')",
    "c.executemany('insert into executions values (?,?,?,?,?)', [('e1', '0f9e8d7c6b5a', 'running', sys.argv[2], sys.argv[2]), ('e2', 'a1b2c3d4e5f6', 'claimed', '2020-01-01T00:00:00+00:00', None)])",
    "c.commit()",
  ].join("\n"), path.join(home, "cron", "executions.db"), new Date().toISOString()], { encoding: "utf8", env: cleanEnv({}) });
  expect(r.status).toBe(0);
  return home;
}

suite("Hermes cron (hq_cron.py and the hook)", { timeout: 30_000 }, () => {
  const CRON = path.join(DIR, "hq_cron.py");

  it("snapshot: no prompts or chat ids, redacted, running only with recent progress", () => {
    const home = fakeHermesHome();
    const r = spawnSync(PY, [CRON, "--once"], { encoding: "utf8", env: cleanEnv({ HERMES_HOME: home, HQ_ENV_FILE: path.join(home, "none.env"), HQ_CRON_SOURCE: "Hermes uji" }) });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/RAHASIA|-100123456|abc123|sk-abc/);
    const snap = JSON.parse(r.stdout);
    expect(snap).toMatchObject({ type: "schedule", source: "Hermes uji", controls: ["run", "pause", "resume"], scheduler: { alive: true } });
    expect(snap.jobs).toEqual([
      { id: "a1b2c3d4e5f6", name: "Laporan harian token=***", schedule: "0 9 * * *", next_run_at: Date.parse("2026-11-04T09:00:00+08:00"), last_run_at: Date.parse("2026-11-03T09:00:02+08:00"), last_status: "ok", last_error: "", state: "scheduled", enabled: true, running: false, failure_streak: 0, deliver: "telegram" },
      { id: "0f9e8d7c6b5a", name: "Cek SSH", schedule: "every 30m", next_run_at: null, last_run_at: new Date("2026-11-03T12:30:00").getTime(), last_status: "error", last_error: "API key *** invalid", state: "paused", enabled: false, running: true, failure_streak: 3, deliver: "local" },
    ]);
    const viewOnly = spawnSync(PY, [CRON, "--once"], { encoding: "utf8", env: cleanEnv({ HERMES_HOME: home, HQ_ENV_FILE: path.join(home, "none.env"), HQ_CRON_CONTROLS: "none" }) });
    expect(JSON.parse(viewOnly.stdout).controls).toEqual([]);
  });

  it("runs office commands as `hermes cron`, after checking them again, and reports back", async () => {
    const home = fakeHermesHome();
    const calls = path.join(home, "calls.txt");
    const fake = path.join(home, "fake_hermes.py");
    fs.writeFileSync(fake, [
      "import json, os, sys",
      "open(os.environ['FAKE_HERMES_LOG'], 'a').write(json.dumps(sys.argv[1:]) + chr(10))",
      "print(chr(27) + '[32mPaused job Cek SSH' + chr(27) + '[0m')", // colored, like the real CLI
    ].join("\n") + "\n");
    const events: Record<string, unknown>[] = [];
    const results: Record<string, unknown>[] = [];
    let served = false;
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        if (req.url === "/api/event") {
          events.push(JSON.parse(data));
          res.writeHead(202).end("{}");
        } else if (req.url?.startsWith("/api/cron/commands")) {
          const commands = served ? [] : [
            { id: "c-1", action: "pause", job: "0f9e8d7c6b5a" },
            { id: "c-2", action: "run", job: "ffffffffffff" },
            { id: "c-3", action: "remove", job: "a1b2c3d4e5f6" },
          ];
          served = true;
          setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, commands })), commands.length ? 0 : 300);
        } else if (req.url === "/api/cron/result") {
          results.push(JSON.parse(data));
          res.writeHead(200).end("{}");
        } else res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const child = spawn(PY, [CRON], { env: cleanEnv({ HERMES_HOME: home, HQ_ENV_FILE: path.join(home, "none.env"), HQ_URL: url, HQ_HERMES_BIN: fake, FAKE_HERMES_LOG: calls }), stdio: "ignore" });
    try {
      for (let i = 0; i < 150 && results.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
    } finally {
      child.kill();
      server.close();
    }
    expect(results).toEqual([
      { id: "c-1", ok: true, message: "Paused job Cek SSH" },
      { id: "c-2", ok: false, message: "jadwal tidak ada di Hermes" },
      { id: "c-3", ok: false, message: "aksi ini dimatikan di reporter (HQ_CRON_CONTROLS)" },
    ]);
    expect(fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([["cron", "pause", "0f9e8d7c6b5a"]]);
    expect(events[0]).toMatchObject({ type: "schedule", controls: ["run", "pause", "resume"] });
  });

  it("hook: a cron run is its own character named after the job, offline when the run ends", () => {
    const home = fakeHermesHome();
    const state = tmp();
    const CRON_SID = "cron_a1b2c3d4e5f6_20261103_090000";
    const run = (p: Record<string, unknown>) => hermesHook(state, { session_id: CRON_SID, cwd: "/home/ubuntu", ...p }, { HERMES_HOME: home, HQ_NAME: "Rexx" });
    const start = run({ hook_event_name: "on_session_start" });
    expect(start[0].headers).toMatchObject({ "X-HQ-Name": "Laporan harian token=***", "X-HQ-Role": "Cron · 0 9 * * *" });
    expect(toEvents(start)[0]).toMatchObject({ name: "Laporan harian token=***", role: "Cron · 0 9 * * *", status: "idle" });
    run({ hook_event_name: "pre_llm_call", extra: { user_message: "kirim laporan harian" } });
    expect(toEvents(run({ hook_event_name: "post_llm_call", extra: { assistant_response: "terkirim" } }))[0]).toMatchObject({ type: "task_done" });
    expect(toEvents(run({ hook_event_name: "on_session_end", extra: { completed: true, interrupted: false } }))).toEqual([
      expect.objectContaining({ status: "offline", task: "Sesi selesai (cron selesai)" }),
    ]);
    // hq_mcp.py of this process keeps reporting for the interactive session, not for the cron run
    expect(JSON.parse(fs.readFileSync(path.join(state, "hermes-state.json"), "utf8")).procs[String(process.pid)]).toBeUndefined();
  });
});
