// Schedule controls over HTTP on the built app (`next start`, needs `npm run build`): the schedule reaches new
// viewers, /api/cron refuses other sites, commands go queued -> sent -> ok over the stream, the long poll wakes up,
// and HQ_TOKEN guards every step.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const BUILT = fs.existsSync(path.join(ROOT, ".next/BUILD_ID"));
const JOB = "a1b2c3d4e5f6";
const SCHEDULE = {
  type: "schedule", source: "Hermes uji", controls: ["run", "pause", "resume"], scheduler: { alive: true },
  jobs: [{ id: JOB, name: "Laporan harian", schedule: "0 9 * * *", next_run_at: Date.now() + 3600e3, state: "scheduled", enabled: true }],
};

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

async function start(token = "") {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: ROOT, env: { ...process.env, HQ_TOKEN: token, HQ_NAMES_FILE: path.join(ROOT, ".next", `names-${port}.json`) }, stdio: "ignore",
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

/** Collect SSE events from /api/stream until aborted. */
function listen(base: string) {
  const events: Record<string, unknown>[] = [];
  const ac = new AbortController();
  void (async () => {
    try {
      const res = await fetch(base + "/api/stream", { signal: ac.signal });
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
  return { events, stop: () => ac.abort() };
}

const until = async (fn: () => boolean, ms = 5000) => {
  for (let t = 0; t < ms && !fn(); t += 50) await new Promise((r) => setTimeout(r, 50));
  expect(fn()).toBe(true);
};

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

describe.skipIf(!BUILT)("schedule controls on next start", { timeout: 60_000 }, () => {
  it("schedule for viewers, CSRF refusal, command lifecycle, long poll", async () => {
    const base = await start();
    expect((await fetch(base + "/api/event", json(SCHEDULE))).status).toBe(202);

    // a new viewer gets the schedule right after the snapshot, with its age; it is not an agent
    const sse = listen(base);
    await until(() => sse.events.some((e) => e.type === "schedule"));
    expect(sse.events[0].type).toBe("snapshot");
    expect(sse.events[1]).toMatchObject({ type: "schedule", source: "Hermes uji", age_ms: expect.any(Number) });
    expect((await (await fetch(base + "/api/agents")).json()).agents).toEqual([]);

    // other websites and non-JSON posts are refused; no CORS on /api/cron
    const cmd = { action: "run", job: JOB };
    expect((await fetch(base + "/api/cron", json(cmd, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await fetch(base + "/api/cron", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(cmd) })).status).toBe(415);
    const pre = await fetch(base + "/api/cron", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(base + "/api/cron", json({ action: "run", job: "ffffffffffff" }))).status).toBe(404);

    // same-origin browser request: queued; the reporter takes it, answers, everyone sees each step
    const ok = await fetch(base + "/api/cron", json(cmd, { origin: base, "sec-fetch-site": "same-origin" }));
    expect(ok.status).toBe(202);
    const id = (await ok.json()).command.id as string;
    const taken = await (await fetch(base + "/api/cron/commands?wait=1")).json();
    expect(taken.commands).toEqual([{ id, action: "run", job: JOB }]);
    expect((await fetch(base + "/api/cron/result", json({ id, ok: true, message: "jalan di tick berikutnya" }))).status).toBe(200);
    await until(() => sse.events.filter((e) => e.type === "cron_command").length === 3);
    expect(sse.events.filter((e) => e.type === "cron_command").map((e) => e.status)).toEqual(["queued", "sent", "ok"]);

    // long poll: a waiting reporter gets the next command right away
    const t0 = Date.now();
    const polling = fetch(base + "/api/cron/commands?wait=20").then((r) => r.json());
    await new Promise((r) => setTimeout(r, 300));
    expect((await fetch(base + "/api/cron", json({ action: "pause", job: JOB }))).status).toBe(202);
    const got = await polling;
    expect(got.commands).toEqual([expect.objectContaining({ action: "pause", job: JOB })]);
    expect(Date.now() - t0).toBeLessThan(5000);
    sse.stop();
  });

  it("HQ_TOKEN guards the panel, the reporter, and the schedule itself", async () => {
    const base = await start("rahasia");
    const auth = { authorization: "Bearer rahasia" };
    expect((await fetch(base + "/api/event", json(SCHEDULE))).status).toBe(401);
    expect((await fetch(base + "/api/event", json(SCHEDULE, auth))).status).toBe(202);
    expect((await fetch(base + "/api/cron", json({ action: "pause", job: JOB }))).status).toBe(401);
    expect((await fetch(base + "/api/cron/commands")).status).toBe(401);
    expect((await fetch(base + "/api/cron", json({ action: "pause", job: JOB }, auth))).status).toBe(202);
    const taken = await (await fetch(base + "/api/cron/commands", { headers: auth })).json();
    expect(taken.commands).toHaveLength(1);
    expect((await fetch(base + "/api/cron/result", json({ id: taken.commands[0].id, ok: true }))).status).toBe(401);
  });
});
