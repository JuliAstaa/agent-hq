// Server monitor over HTTP on the built app (`next start`, needs `npm run build`, prd.md §7.8): sampling starts with
// the server (instrumentation.ts), so the first viewer already gets history; a viewer of /api/stream receives samples,
// a later viewer gets the latest one right after the snapshot, and HQ_SERVER_STATS=0 turns it off.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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
afterAll(() => {
  for (const p of procs) p.kill();
});

async function start(env: Record<string, string> = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: ROOT, env: { ...process.env, HQ_NAMES_FILE: path.join(ROOT, ".next", `names-${port}.json`), ...env }, stdio: "ignore",
  });
  procs.add(proc);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) return base;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("next start did not come up");
}

function listen(base: string) {
  const events: Record<string, unknown>[] = [];
  const ac = new AbortController();
  void (async () => {
    try {
      const res = await fetch(base + "/api/stream", { signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of chunk.split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
        }
      }
    } catch {}
  })();
  return { events, stop: () => ac.abort() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 6000) => {
  for (let t = 0; t < ms && !fn(); t += 50) await sleep(50);
  expect(fn()).toBe(true);
};

describe.skipIf(!BUILT)("server monitor on next start", () => {
  it("samples reach viewers; a later viewer gets the latest sample after the snapshot", async () => {
    const base = await start();
    const a = listen(base);
    await until(() => a.events.some((e) => e.type === "server_stats"));
    const s = a.events.find((e) => e.type === "server_stats")!;
    expect(s).toMatchObject({ platform: expect.any(String), interval_ms: 5000 });
    expect(s.mem_total as number).toBeGreaterThan(0);
    const b = listen(base);
    await until(() => b.events.length >= 2);
    expect(b.events[0].type).toBe("snapshot");
    expect(b.events[1]).toMatchObject({ type: "server_stats" });
    expect(b.events[1].age_ms as number).toBeGreaterThanOrEqual(0);
    const agents = await (await fetch(base + "/api/agents")).json();
    expect(agents.agents).toEqual([]); // never an agent
    a.stop();
    b.stop();
  }, 60_000);

  it("samples from server start, before anyone watches: the first viewer gets history", async () => {
    const base = await start();
    await sleep(7000); // first sample 1 s after start, the next 5 s later
    const v = listen(base);
    await until(() => v.events.length >= 2);
    expect(v.events[0].type).toBe("snapshot");
    const s = v.events[1];
    expect(s.type).toBe("server_stats");
    const history = s.history as { age_ms: number; cpu: number | null; mem: number | null; disk: number | null }[];
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].age_ms).toBeGreaterThan(s.age_ms as number);
    expect(history[0].mem as number).toBeGreaterThan(0);
    expect(history[0].mem as number).toBeLessThanOrEqual(1);
    v.stop();
  }, 60_000);

  it("HQ_SERVER_STATS=0 sends no samples", async () => {
    const base = await start({ HQ_SERVER_STATS: "0" });
    const v = listen(base);
    await until(() => v.events.length >= 1); // snapshot
    await sleep(2500);
    expect(v.events.filter((e) => e.type === "server_stats")).toEqual([]);
    v.stop();
  }, 60_000);
});
