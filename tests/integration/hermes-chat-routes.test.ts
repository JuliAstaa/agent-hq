// Hermes chat over HTTP on the built app (`next start`, needs `npm run build`) against a fake Hermes API server:
// the panel's stream, a message through to the final answer, and the guard (other sites, other hosts, HQ_TOKEN).

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helloTurn, startFakeHermes, type FakeHermes, type Turn } from "../helpers/fake-hermes-api";

const ROOT = path.resolve(__dirname, "../..");
const BUILT = fs.existsSync(path.join(ROOT, ".next/BUILD_ID"));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

const procs = new Set<ChildProcess>();
let fake: FakeHermes;
beforeAll(async () => {
  fake = await startFakeHermes();
});
afterAll(async () => {
  for (const p of procs) p.kill();
  await fake?.close();
});

async function start(env: Record<string, string>) {
  const port = await freePort();
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("HQ_")) delete base[k];
  const proc = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: ROOT,
    env: { ...base, HQ_NAMES_FILE: path.join(ROOT, ".next", `names-${port}.json`), HQ_HERMES_CHAT_FILE: path.join(ROOT, ".next", `hermes-${port}.json`), ...env },
    stdio: "ignore",
  });
  procs.add(proc);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(url + "/api/health")).ok) return { url, port };
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("next start did not come up");
}

/** Collect chat events from /api/hermes/stream until aborted. */
function listen(base: string, headers: Record<string, string> = {}) {
  const events: Record<string, unknown>[] = [];
  const ac = new AbortController();
  const status = (async () => {
    const res = await fetch(base + "/api/hermes/stream", { headers, signal: ac.signal });
    if (!res.ok) return res.status;
    void (async () => {
      try {
        const reader = res.body!.getReader();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value);
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of chunk.split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
          }
        }
      } catch {}
    })();
    return res.status;
  })();
  return { events, status, stop: () => ac.abort() };
}

const until = async (fn: () => boolean, ms = 8000) => {
  for (let t = 0; t < ms && !fn(); t += 50) await new Promise((r) => setTimeout(r, 50));
  expect(fn()).toBe(true);
};

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + "/api/hermes", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Raw request with a chosen Host header (fetch does not let a test pick it). */
const withHost = (port: number, host: string, p: string) =>
  new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on("error", reject);
    req.end();
  });

describe.skipIf(!BUILT)("Hermes chat on next start", { timeout: 60_000 }, () => {
  it("stream, a message to the final answer, and the guard", async () => {
    const { url, port } = await start({ HQ_HERMES_API_KEY: fake.key, HQ_HERMES_API_URL: fake.url });
    expect(await (await fetch(url + "/api/hermes")).json()).toEqual({ ok: true, enabled: true });

    const sse = listen(url);
    expect(await sse.status).toBe(200);
    await until(() => sse.events.some((e) => e.type === "chat_snapshot"));

    const r = await post(url, { action: "send", text: "halo" }, { origin: url, "sec-fetch-site": "same-origin" });
    expect(r.status).toBe(202);
    await until(() => sse.events.some((e) => e.type === "chat_state" && e.phase === "idle" && sse.events.some((x) => x.type === "chat_item" && (x.item as { text?: string }).text === "Halo!")));
    expect(fake.calls.some((c) => c.path.endsWith("/chat/stream") && c.auth === `Bearer ${fake.key}`)).toBe(true);
    sse.stop();

    // other websites, other host names (DNS rebinding), non-JSON posts; no CORS
    expect((await post(url, { action: "new" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(await withHost(port, "evil.example:8787", "/api/hermes/stream")).toBe(403);
    expect(await withHost(port, `localhost:${port}`, "/api/hermes")).toBe(200);
    expect((await fetch(url + "/api/hermes", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    const pre = await fetch(url + "/api/hermes", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("a new session's character shows up in the office routes; Riwayat lists it", async () => {
    const { url, port } = await start({ HQ_HERMES_API_KEY: fake.key, HQ_HERMES_API_URL: fake.url });
    const r = await post(url, { action: "new", agent: { name: "Budi", role: "Analis SOC", team: "blue" } });
    expect(r.status).toBe(200);
    const { sessionId, agentId } = (await r.json()) as { sessionId: string; agentId: string };
    // the chat route and the office routes share one hub (globalThis), so the office sees the character
    const agents = ((await (await fetch(url + "/api/agents")).json()) as { agents: { id: string; name: string; team: string | null }[] }).agents;
    expect(agents).toContainEqual(expect.objectContaining({ id: agentId, name: "Budi", team: "blue" }));
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, ".next", `names-${port}.json`), "utf8")).agents[agentId]).toMatchObject({ name: "Budi" });
    const list = (await (await post(url, { action: "sessions" })).json()) as { sessions: { id: string }[]; current: string };
    expect(list.current).toBe(sessionId);
    expect(list.sessions.map((s) => s.id)).toContain(sessionId);
    expect((await post(url, { action: "model", model: { provider: "p", model: "m" } })).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, ".next", `hermes-${port}.json`), "utf8")).sessions[sessionId].model).toEqual({ provider: "p", model: "m" });
  });

  it("HQ_TOKEN guards the stream and the actions; no key means no chat", async () => {
    const { url } = await start({ HQ_HERMES_API_KEY: fake.key, HQ_HERMES_API_URL: fake.url, HQ_TOKEN: "rahasia" });
    expect(await listen(url).status).toBe(401);
    expect((await post(url, { action: "new" })).status).toBe(401);
    const sse = listen(url, { authorization: "Bearer rahasia" });
    expect(await sse.status).toBe(200);
    sse.stop();
    expect((await post(url, { action: "new" }, { "x-hq-token": "rahasia" })).status).toBe(200);

    const off = await start({});
    expect(await (await fetch(off.url + "/api/hermes")).json()).toEqual({ ok: true, enabled: false });
    expect((await post(off.url, { action: "send", text: "x" })).status).toBe(404);
  });

  it("two sessions run concurrently across panel switches and reconnects; stop affects only its target", async () => {
    const turns = new Map<string, Turn>();
    fake.script = async (t) => {
      turns.set(t.sessionId, t);
      t.send("run.started");
      await t.stopped;
      t.send("run.cancelled");
      t.send("done");
    };
    const { url } = await start({ HQ_HERMES_API_KEY: fake.key, HQ_HERMES_API_URL: fake.url });
    let sse = listen(url);
    try {
      expect(await sse.status).toBe(200);
      const a = await (await post(url, { action: "new", agent: { name: "A" } })).json();
      expect((await post(url, { action: "send", sessionId: a.sessionId, text: "kerja A" })).status).toBe(202);
      await until(() => turns.has(a.sessionId));
      const b = await (await post(url, { action: "new", agent: { name: "B" } })).json();
      expect(b.ok).toBe(true);
      expect((await post(url, { action: "send", sessionId: b.sessionId, text: "kerja B" })).status).toBe(202);
      await until(() => turns.has(b.sessionId));
      const list = await (await post(url, { action: "sessions" })).json();
      expect(list.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: a.sessionId, phase: "running" }),
        expect.objectContaining({ id: b.sessionId, phase: "running" }),
      ]));
      const agents = (await (await fetch(url + "/api/agents")).json()).agents;
      expect(agents).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: a.agentId, status: "thinking" }),
        expect.objectContaining({ id: b.agentId, status: "thinking" }),
      ]));
      expect((await post(url, { action: "open", sessionId: a.sessionId })).status).toBe(200);
      sse.stop();
      sse = listen(url);
      expect(await sse.status).toBe(200);
      await until(() => sse.events.some((e) => e.type === "chat_snapshot" && (e.view as { sessionId: string }).sessionId === a.sessionId));
      expect((await post(url, { action: "stop", sessionId: a.sessionId })).status).toBe(202);
      await until(() => sse.events.some((e) => e.type === "chat_state" && e.sessionId === a.sessionId && e.phase === "idle"));
      const still = await (await post(url, { action: "sessions" })).json();
      expect(still.sessions).toContainEqual(expect.objectContaining({ id: b.sessionId, phase: "running" }));
      expect((await post(url, { action: "stop", sessionId: b.sessionId })).status).toBe(202);
    } finally {
      sse.stop();
      for (const t of turns.values()) t.drop();
      fake.script = helloTurn;
    }
  });
});
