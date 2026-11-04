// Real process restart, including a forced exit: new viewers must receive agents before any new hook.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const BUILT = fs.existsSync(path.join(ROOT, ".next/BUILD_ID"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-restart-it-"));
const procs = new Set<ChildProcess>();
afterAll(() => {
  for (const proc of procs) proc.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
});

async function start() {
  const port = await new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
  const proc = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: ROOT,
    env: { ...process.env, HQ_STATE_FILE: path.join(dir, "state.json"), HQ_NAMES_FILE: path.join(dir, "names.json"), HQ_SERVER_STATS: "0", HQ_TOKEN: "" },
    stdio: "ignore",
  });
  procs.add(proc);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { ready = (await fetch(base + "/api/health")).ok; } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!ready) throw new Error("restart server did not start");
  return {
    base,
    stop: () => new Promise<void>((resolve) => {
      proc.once("exit", () => { procs.delete(proc); resolve(); });
      proc.kill("SIGKILL");
    }),
  };
}

async function stream(base: string, replay = false) {
  const ctrl = new AbortController();
  const res = await fetch(base + "/stream", { signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(5000)]) });
  const reader = res.body!.getReader();
  let raw = "";
  while (!raw.includes('"type":"snapshot"') || (replay && !raw.includes('"_replay":true'))) raw += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  return raw.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
}

describe.skipIf(!BUILT)("persistent bridge over HTTP", () => {
  it("restores hook agents, rename, totals and SSE replay after SIGKILL; deleted agents stay deleted", async () => {
    let srv = await start();
    const post = async (url: string, body: unknown) => fetch(srv.base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/hook", { session_id: "abcd1234", cwd: "/project", hook_event_name: "UserPromptSubmit", prompt: "cek token=private" })).status).toBe(200);
    expect((await post("/event", { type: "rename", id: "cc-abcd1234", name: "Rexx", team: "red" })).status).toBe(202);
    await post("/api/event", [{ id: "cc-abcd1234", tokens: 1234 }, { id: "gone", status: "idle" }, { type: "remove", id: "gone" }]);
    await srv.stop();

    srv = await start();
    const rows = await (await fetch(srv.base + "/api/agents")).json();
    expect(rows.agents).toEqual([expect.objectContaining({ id: "cc-abcd1234", name: "Rexx", team: "red", status: "thinking", renamed: true })]);
    const events = await stream(srv.base, true);
    expect(events[0]).toMatchObject({ type: "snapshot", agents: [{ id: "cc-abcd1234", name: "Rexx", tokens: 1234, task: "cek token=***" }] });
    expect(events.some((ev) => ev.type === "log" && ev._replay === true)).toBe(true);
    await post("/api/event", { type: "remove", id: "cc-abcd1234" });
    await srv.stop();

    srv = await start();
    expect((await stream(srv.base))[0]).toEqual({ type: "snapshot", agents: [] });
    await srv.stop();
  }, 60000);
});
