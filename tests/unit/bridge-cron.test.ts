// Bridge side of the schedule controls (lib/bridge/cron.ts): validation, queue, long poll, results, CSRF check.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CMD_TIMEOUT_MS, crossSite, enqueueCommand, expireCommands, finishCommand, scheduleForViewer, takeCommands, waitForCommands,
} from "@/lib/bridge/cron";
import { hub, publish, resetHub, type BridgeEvent } from "@/lib/bridge/hub";

const SCHEDULE = {
  type: "schedule", source: "Hermes di vps", controls: ["run", "pause"], scheduler: { alive: true },
  jobs: [{ id: "a1b2c3d4e5f6", name: "Laporan harian" }, { id: "0f9e8d7c6b5a", name: "Cek SSH" }],
};
let seen: BridgeEvent[] = [];

beforeEach(() => {
  resetHub();
  seen = [];
  hub.subs.add((ev) => seen.push(ev));
});
afterEach(() => resetHub());

const req = (headers: Record<string, string>) => new Request("http://localhost:8787/api/cron", { method: "POST", headers });

describe("crossSite", () => {
  it("same origin, tunnel port and non-browser clients pass", () => {
    expect(crossSite(req({ host: "localhost:8787", origin: "http://localhost:8787", "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(crossSite(req({ host: "localhost:9787", origin: "http://localhost:9787" }))).toBe(false);
    expect(crossSite(req({ host: "127.0.0.1:8787" }))).toBe(false); // curl, the reporter
  });
  it("other sites are refused", () => {
    expect(crossSite(req({ host: "localhost:8787", origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(crossSite(req({ host: "localhost:8787", "sec-fetch-site": "same-site" }))).toBe(true); // another port on localhost
    expect(crossSite(req({ host: "localhost:8787", origin: "http://localhost:3000" }))).toBe(true);
    expect(crossSite(req({ host: "localhost:8787", origin: "null" }))).toBe(true);
  });
});

describe("schedule snapshot", () => {
  it("is stored for new viewers, never as an agent", () => {
    expect(scheduleForViewer()).toBeNull();
    publish({ ...SCHEDULE });
    expect(hub.agents.size).toBe(0);
    const v = scheduleForViewer(Date.now() + 5000)!;
    expect(v).toMatchObject({ type: "schedule", source: "Hermes di vps" });
    expect(v.age_ms).toBeGreaterThanOrEqual(5000);
  });
});

describe("commands", () => {
  it("validates against the latest schedule", () => {
    expect(enqueueCommand({ action: "run", job: "a1b2c3d4e5f6" }).status).toBe(409); // no schedule yet
    publish({ ...SCHEDULE });
    expect(enqueueCommand({ action: "remove", job: "a1b2c3d4e5f6" }).status).toBe(400);
    expect(enqueueCommand({ action: "run", job: "../etc" }).status).toBe(400);
    expect(enqueueCommand({ action: "resume", job: "a1b2c3d4e5f6" }).status).toBe(403); // not in controls
    expect(enqueueCommand({ action: "run", job: "ffffffffffff" }).status).toBe(404);
    expect(enqueueCommand({ action: "run", job: "a1b2c3d4e5f6" }, Date.now() + 91_000).status).toBe(503); // stale
    publish({ ...SCHEDULE, offline: true });
    expect(enqueueCommand({ action: "run", job: "a1b2c3d4e5f6" }).status).toBe(503);
  });

  it("queued -> sent -> ok, one open command per job, every step broadcast", () => {
    publish({ ...SCHEDULE });
    const r = enqueueCommand({ action: "run", job: "a1b2c3d4e5f6" });
    expect(r.status).toBe(202);
    const id = (r.body.command as { id: string }).id;
    expect(enqueueCommand({ action: "pause", job: "a1b2c3d4e5f6" }).status).toBe(409);
    expect(takeCommands()).toEqual([{ id, action: "run", job: "a1b2c3d4e5f6" }]);
    expect(takeCommands()).toEqual([]);
    expect(finishCommand({ id, ok: true, message: "jalan, token=abc123" }).status).toBe(200);
    expect(finishCommand({ id, ok: true }).status).toBe(409);
    expect(finishCommand({ id: "c-nope", ok: true }).status).toBe(404);
    const steps = seen.filter((e) => e.type === "cron_command").map((e) => [e.status, e.message]);
    expect(steps).toEqual([["queued", ""], ["sent", ""], ["ok", "jalan, token=***"]]);
    expect(hub.agents.size).toBe(0);
  });

  it("long poll wakes on a new command", async () => {
    publish({ ...SCHEDULE });
    const t0 = Date.now();
    const waiting = waitForCommands(10_000);
    setTimeout(() => enqueueCommand({ action: "pause", job: "0f9e8d7c6b5a" }), 50);
    await waiting;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(takeCommands()).toHaveLength(1);
  });

  it("long poll ends on abort", async () => {
    const ac = new AbortController();
    const waiting = waitForCommands(10_000, ac.signal);
    ac.abort();
    await expect(waiting).resolves.toBeUndefined();
    expect(hub.cron.waiters.size).toBe(0);
  });

  it("unanswered commands fail after CMD_TIMEOUT_MS", () => {
    publish({ ...SCHEDULE });
    enqueueCommand({ action: "run", job: "a1b2c3d4e5f6" });
    expireCommands(Date.now() + CMD_TIMEOUT_MS + 1);
    const last = seen.filter((e) => e.type === "cron_command").at(-1)!;
    expect(last).toMatchObject({ status: "error", message: "Reporter jadwal tidak menjawab" });
  });
});
