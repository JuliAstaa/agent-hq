// Bridge parity: replay recorded payloads to the prototype bridge (references/server.js) and to the
// Next.js app (next start), then compare HTTP responses and SSE output (ignoring `ts`).
// Needs a production build (`npm run build`); skipped otherwise.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const BUILT = existsSync(path.join(ROOT, ".next/BUILD_ID"));
const FIXTURE = path.join(ROOT, "tests/fixtures/session.jsonl");

// parity: false marks lines whose output intentionally differs from the prototype (B2 redaction extensions).
type Line = { to: "hook" | "event"; headers?: Record<string, string>; body?: unknown; raw?: string; parity?: boolean };
type Target = { name: string; base: string; paths: Record<"hook" | "event" | "stream" | "health", string>; proc: ChildProcess };

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
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not start: " + url);
}

async function startPair(env: Record<string, string> = {}): Promise<[Target, Target]> {
  const [p1, p2] = [await freePort(), await freePort()];
  const ref = spawn(process.execPath, [path.join(ROOT, "references/server.js")], {
    env: { ...process.env, PORT: String(p1), HOST: "127.0.0.1", ...env },
    stdio: "ignore",
  });
  const next = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(p2)], {
    cwd: ROOT,
    // Never read the user's agent-hq-names.json (rename overrides, deviation 11): a missing temp file = no overrides.
    env: { ...process.env, HQ_NAMES_FILE: path.join(os.tmpdir(), `hq-parity-${process.pid}-${p2}.json`), ...env },
    stdio: "ignore",
  });
  const a: Target = { name: "prototype", base: `http://127.0.0.1:${p1}`, paths: { hook: "/hook", event: "/event", stream: "/stream", health: "/health" }, proc: ref };
  const b: Target = { name: "next", base: `http://127.0.0.1:${p2}`, paths: { hook: "/api/hook", event: "/api/event", stream: "/api/stream", health: "/api/health" }, proc: next };
  await Promise.all([waitFor(a.base + a.paths.health), waitFor(b.base + b.paths.health)]);
  return [a, b];
}

/** Opens an SSE connection and collects raw frames until stop(). */
function viewer(t: Target) {
  const frames: string[] = [];
  const ctrl = new AbortController();
  let buf = "";
  const done = (async () => {
    try {
      const res = await fetch(t.base + t.paths.stream, { signal: ctrl.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          frames.push(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      }
    } catch {}
  })();
  return { frames, stop: async () => { ctrl.abort(); await done; } };
}

function normalizeFrames(frames: string[]) {
  return frames
    .filter((f) => !f.startsWith(":"))
    .map((f) => {
      if (!f.startsWith("data: ")) return f;
      const ev = JSON.parse(f.slice(6));
      delete ev.ts;
      return ev;
    });
}

async function send(t: Target, line: Line) {
  const res = await fetch(t.base + t.paths[line.to], {
    method: "POST",
    headers: { "content-type": "application/json", ...(line.headers || {}) },
    body: line.raw !== undefined ? line.raw : JSON.stringify(line.body),
  });
  return { status: res.status, type: res.headers.get("content-type"), body: await res.text(), cors: res.headers.get("access-control-allow-origin") };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const allLines: Line[] = readFileSync(FIXTURE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const lines = allLines.filter((l) => l.parity !== false);
const b2Lines = allLines.filter((l) => l.parity === false);

describe.skipIf(!BUILT)("bridge parity with references/server.js", () => {
  let pair: [Target, Target];
  beforeAll(async () => {
    pair = await startPair();
  }, 60000);
  afterAll(() => {
    for (const t of pair ?? []) t.proc.kill();
  });

  it("same HTTP responses and same SSE output for the recorded session", async () => {
    const [ref, nxt] = pair;
    const live = [viewer(ref), viewer(nxt)];
    await sleep(400);
    for (const [i, line] of lines.entries()) {
      const [r1, r2] = await Promise.all([send(ref, line), send(nxt, line)]);
      expect({ i, ...r2 }, `fixture line ${i + 1}`).toEqual({ i, ...r1 });
    }
    await sleep(400);
    const late = [viewer(ref), viewer(nxt)];
    await sleep(500);
    const [h1, h2] = await Promise.all([fetch(ref.base + ref.paths.health).then((r) => r.json()), fetch(nxt.base + nxt.paths.health).then((r) => r.json())]);
    for (const v of [...live, ...late]) await v.stop();

    expect(h2).toEqual(h1);
    const liveRef = normalizeFrames(live[0].frames);
    expect(liveRef.length).toBeGreaterThan(40);
    expect(normalizeFrames(live[1].frames)).toEqual(liveRef);
    const lateRef = normalizeFrames(late[0].frames);
    expect(lateRef[0]).toBe("retry: 2000");
    expect(lateRef.filter((e) => typeof e === "object" && e._replay).length).toBeGreaterThan(20);
    expect(normalizeFrames(late[1].frames)).toEqual(lateRef);
  }, 60000);

  it("same OPTIONS preflight", async () => {
    const [ref, nxt] = pair;
    const [a, b] = await Promise.all([
      fetch(ref.base + "/event", { method: "OPTIONS" }),
      fetch(nxt.base + "/api/event", { method: "OPTIONS" }),
    ]);
    expect(b.status).toBe(a.status);
    for (const h of ["access-control-allow-origin", "access-control-allow-headers", "access-control-allow-methods"]) {
      expect(b.headers.get(h)).toBe(a.headers.get(h));
    }
  });

  it("stream headers", async () => {
    const [, nxt] = pair;
    const ctrl = new AbortController();
    const res = await fetch(nxt.base + "/api/stream", { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("content-encoding")).toBeNull();
    ctrl.abort();
  });
});

describe.skipIf(!BUILT)("B2 redaction extensions (app only, intentionally differs from the prototype)", () => {
  let pair: [Target, Target];
  beforeAll(async () => {
    pair = await startPair();
  }, 60000);
  afterAll(() => {
    for (const t of pair ?? []) t.proc.kill();
  });

  it("secrets in parity:false fixtures never reach the stream", async () => {
    const [, nxt] = pair;
    expect(b2Lines.length).toBeGreaterThan(0);
    const v = viewer(nxt);
    await sleep(300);
    for (const line of b2Lines) expect((await send(nxt, line)).status).toBe(200);
    await sleep(400);
    await v.stop();
    const raw = v.frames.join("\n");
    expect(raw).toContain("-p***");
    expect(raw).not.toContain("S3cretPass");
  }, 30000);
});

describe.skipIf(!BUILT)("bridge parity with HQ_TOKEN set", () => {
  let pair: [Target, Target];
  beforeAll(async () => {
    pair = await startPair({ HQ_TOKEN: "t0k3n" });
  }, 60000);
  afterAll(() => {
    for (const t of pair ?? []) t.proc.kill();
  });

  it("401 without token, accepted with Bearer or x-hq-token", async () => {
    const ev: Line = { to: "event", body: { id: "a", status: "working" } };
    const hook: Line = { to: "hook", body: { hook_event_name: "SessionStart", session_id: "s" } };
    const variants: Record<string, string>[] = [{}, { Authorization: "Bearer nope" }, { Authorization: "Bearer t0k3n" }, { "x-hq-token": "t0k3n" }];
    for (const headers of variants) {
      for (const line of [ev, hook]) {
        const [r1, r2] = await Promise.all(pair.map((t) => send(t, { ...line, headers })));
        expect(r2, JSON.stringify({ headers, to: line.to })).toEqual(r1);
      }
    }
  }, 30000);
});

// The Next app also serves the prototype URLs (/hook, /event, /stream, /health) through rewrites in
// next.config.ts, so hook configs written for references/server.js keep working on port 8787.
describe.skipIf(!BUILT)("bridge parity through prototype URLs (rewrites)", () => {
  let pair: [Target, Target];
  beforeAll(async () => {
    pair = await startPair();
    pair[1] = { ...pair[1], name: "next-alias", paths: { ...pair[0].paths } };
  }, 60000);
  afterAll(() => {
    for (const t of pair ?? []) t.proc.kill();
  });

  it("same HTTP responses and same live SSE output", async () => {
    const [ref, nxt] = pair;
    const live = [viewer(ref), viewer(nxt)];
    await sleep(400);
    for (const [i, line] of lines.entries()) {
      const [r1, r2] = await Promise.all([send(ref, line), send(nxt, line)]);
      expect({ i, ...r2 }, `fixture line ${i + 1}`).toEqual({ i, ...r1 });
    }
    await sleep(400);
    const [h1, h2] = await Promise.all([fetch(ref.base + "/health").then((r) => r.json()), fetch(nxt.base + "/health").then((r) => r.json())]);
    for (const v of live) await v.stop();
    expect(h2).toEqual(h1);
    const liveRef = normalizeFrames(live[0].frames);
    expect(liveRef.length).toBeGreaterThan(40);
    expect(normalizeFrames(live[1].frames)).toEqual(liveRef);
  }, 60000);

  it("/stream is not buffered: an event posted after connect arrives promptly", async () => {
    const [, nxt] = pair;
    const ctrl = new AbortController();
    const res = await fetch(nxt.base + "/stream", { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("content-encoding")).toBeNull();
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    await reader.read(); // retry + snapshot
    const t0 = Date.now();
    await fetch(nxt.base + "/event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "probe", task: "unbuffered-probe" }) });
    while (!buf.includes("unbuffered-probe")) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    expect(buf).toContain("unbuffered-probe");
    expect(Date.now() - t0).toBeLessThan(1000);
    ctrl.abort();
  }, 30000);

  it("same OPTIONS preflight on /hook", async () => {
    const [ref, nxt] = pair;
    const [a, b] = await Promise.all([fetch(ref.base + "/hook", { method: "OPTIONS" }), fetch(nxt.base + "/hook", { method: "OPTIONS" })]);
    expect(b.status).toBe(a.status);
    for (const h of ["access-control-allow-origin", "access-control-allow-headers", "access-control-allow-methods"]) {
      expect(b.headers.get(h)).toBe(a.headers.get(h));
    }
  });
});
