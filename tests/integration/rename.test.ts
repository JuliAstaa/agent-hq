// Agent rename over HTTP (prd.md §7.4): POST /event {"type":"rename"}, GET /agents, overrides that survive a
// restart. Runs against the Next.js app (`next start`, needs `npm run build`) and examples/server.js, through
// both URL sets (/api/* and the prototype aliases).

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const BUILT = fs.existsSync(path.join(ROOT, ".next/BUILD_ID"));
const SID = "ab12cd34ef";
const CWD = "/Users/dev/projects/property-web";
const ID = "cc-ab12cd34";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

async function waitFor(url: string, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not start: " + url);
}

type Kind = "next" | "standalone";
const procs = new Set<ChildProcess>();
afterAll(() => {
  for (const p of procs) p.kill();
});

async function start(kind: Kind, namesFile: string) {
  const port = await freePort();
  const env = { ...process.env, HQ_NAMES_FILE: namesFile, HQ_TOKEN: "", PORT: String(port), HOST: "127.0.0.1" };
  const proc =
    kind === "next"
      ? spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: ROOT, env, stdio: "ignore" })
      : spawn(process.execPath, [path.join(ROOT, "examples/server.js")], { cwd: ROOT, env, stdio: "ignore" });
  procs.add(proc);
  const base = `http://127.0.0.1:${port}`;
  await waitFor(base + "/health");
  const stop = () =>
    new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.kill();
      procs.delete(proc);
    });
  return { base, stop };
}

const post = async (base: string, p: string, body: unknown) => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const agents = async (base: string, p: string) => ((await (await fetch(base + p)).json()) as { agents: Record<string, unknown>[] }).agents;
const hook = (h: Record<string, unknown>) => ({ session_id: SID, cwd: CWD, ...h });

for (const kind of ["next", "standalone"] as Kind[]) {
  for (const urls of ["api", "alias"] as const) {
    const P = urls === "api" ? { event: "/api/event", hook: "/api/hook", agents: "/api/agents" } : { event: "/event", hook: "/hook", agents: "/agents" };
    describe.skipIf(kind === "next" && !BUILT)(`rename via ${kind} (${urls} URLs)`, () => {
      it("names, renames, keeps the name across hooks and a restart, 404s, clears team", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-rename-it-"));
        const file = path.join(dir, "agent-hq-names.json");
        let srv = await start(kind, file);

        // hook name: <folder>#<4 of session>
        expect((await post(srv.base, P.hook, hook({ hook_event_name: "UserPromptSubmit", prompt: "cek" }))).status).toBe(200);
        expect(await agents(srv.base, P.agents)).toEqual([{ id: ID, name: "property-web#ab12", role: "Claude Code · property-web", team: null, status: "thinking", renamed: false }]);

        // unknown match -> 404 pointing at GET /agents
        const miss = await post(srv.base, P.event, { type: "rename", match: "ghost#0000", name: "X" });
        expect(miss.status).toBe(404);
        expect(miss.body.ok).toBe(false);
        expect(miss.body.error).toMatch(/GET \/agents/);

        // rename by displayed name, then a later hook keeps it
        const ok = await post(srv.base, P.event, { type: "rename", match: "property-web#ab12", name: "Rexx", team: "red", role: "Pentester" });
        expect(ok.status).toBe(202);
        expect(ok.body).toMatchObject({ ok: true, id: ID, matchedBy: "name", after: { name: "Rexx", team: "red", role: "Pentester" } });
        await post(srv.base, P.hook, hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "nmap -sV staging" } }));
        expect((await agents(srv.base, P.agents))[0]).toMatchObject({ id: ID, name: "Rexx", team: "red", status: "working", renamed: true });
        expect(JSON.parse(fs.readFileSync(file, "utf8")).agents[ID]).toMatchObject({ name: "Rexx", team: "red", role: "Pentester" });

        // restart: a new hook for the same session is Rexx right away
        await srv.stop();
        srv = await start(kind, file);
        await post(srv.base, P.hook, hook({ hook_event_name: "SessionStart", source: "resume" }));
        expect((await agents(srv.base, P.agents))[0]).toMatchObject({ id: ID, name: "Rexx", team: "red" });

        // team null: gone from the file, agent sent back to the office desk
        const clear = await post(srv.base, P.event, { type: "rename", match: "ab12", team: null });
        expect(clear.status).toBe(202);
        const saved = JSON.parse(fs.readFileSync(file, "utf8")).agents[ID];
        expect(saved).toMatchObject({ name: "Rexx" });
        expect(saved).not.toHaveProperty("team");
        expect((await agents(srv.base, P.agents))[0]).toMatchObject({ name: "Rexx", team: "office" });

        // plain events are answered exactly as before
        expect(await post(srv.base, P.event, { id: "x", status: "working" })).toEqual({ status: 202, body: { ok: true, received: 1 } });

        await srv.stop();
        fs.rmSync(dir, { recursive: true, force: true });
      }, 90000);
    });
  }
}
