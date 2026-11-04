// Server monitor, bridge side (lib/bridge/server-stats.ts, prd.md §7.8): readings, the sampling loop that runs from
// server start (also without viewers), the latest sample and 30 minutes of history for new viewers, and the stream /
// event routes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import { POST as postEvent } from "@/app/api/event/route";
import { GET as getStream } from "@/app/api/stream/route";
import { hub, listAgents, publish, resetHub, type BridgeEvent } from "@/lib/bridge/hub";
import { SERVER_HISTORY_MAX, SERVER_HISTORY_MS } from "@/lib/server";
import {
  cpuBusy, cpuTimes, diskPath, ensureServerStats, FIRST_SAMPLE_MS, parseMeminfo, sampleServer, serverStatsEnabled,
  serverStatsForViewer, VIEWER_MAX_AGE_MS,
} from "@/lib/bridge/server-stats";
import { sseFrames } from "@/lib/sse";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const savedEnv = { ...process.env };

beforeEach(() => resetHub());
afterEach(() => {
  resetHub();
  process.env = { ...savedEnv };
});

describe("readings", () => {
  it("CPU busy share is the difference of two readings", () => {
    expect(cpuBusy(null, { idle: 10, total: 20 })).toBeNull();
    expect(cpuBusy({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBeNull(); // no time passed
    expect(cpuBusy({ idle: 100, total: 200 }, { idle: 130, total: 300 })).toBeCloseTo(0.7);
    expect(cpuBusy({ idle: 100, total: 200 }, { idle: 200, total: 300 })).toBe(0);
    const t = cpuTimes([{ model: "x", speed: 1, times: { user: 5, nice: 1, sys: 2, idle: 10, irq: 2 } }]);
    expect(t).toEqual({ idle: 10, total: 20 });
  });

  it("parses MemTotal and MemAvailable from /proc/meminfo", () => {
    const text = "MemTotal:        3989960 kB\nMemFree:          201376 kB\nMemAvailable:    1546124 kB\nBuffers:  1 kB\n";
    expect(parseMeminfo(text)).toEqual({ total: 3989960 * 1024, avail: 1546124 * 1024 });
    expect(parseMeminfo("MemTotal: 1000 kB\nMemFree: 10 kB\n")).toBeNull(); // kernels without MemAvailable
    expect(parseMeminfo("")).toBeNull();
  });

  it("a sample has every field, plausible values, and nothing that names the machine", async () => {
    const first = await sampleServer(null);
    expect(first.ev.cpu).toBeNull(); // needs a previous reading
    await sleep(60);
    const { ev } = await sampleServer(first.cpu);
    expect(Object.keys(ev).sort()).toEqual([
      "app_rss", "cores", "cpu", "disk_avail", "disk_size", "disk_used", "interval_ms", "load", "mem_total", "mem_used",
      "platform", "type", "uptime_s",
    ]);
    expect(ev.type).toBe("server_stats");
    expect(ev.platform).toBe(process.platform);
    if (ev.cpu !== null) expect(ev.cpu as number).toBeGreaterThanOrEqual(0);
    expect(ev.cpu === null || (ev.cpu as number) <= 1).toBe(true);
    expect(ev.cores).toBe(os.availableParallelism());
    expect(ev.mem_total as number).toBeGreaterThan(0);
    expect(ev.mem_used as number).toBeGreaterThan(0);
    expect(ev.mem_used as number).toBeLessThanOrEqual(ev.mem_total as number);
    expect(ev.disk_size as number).toBeGreaterThan(0);
    expect((ev.disk_used as number) + (ev.disk_avail as number)).toBeLessThanOrEqual(ev.disk_size as number);
    expect(ev.app_rss as number).toBeGreaterThan(0);
    if (process.platform === "win32") expect(ev.load).toBeNull();
    else expect(ev.load).toHaveLength(3);
    const raw = JSON.stringify(ev);
    expect(raw).not.toContain(os.hostname());
    expect(raw).not.toContain(os.userInfo().username);
  });

  it("an unreadable disk path gives nulls, not an error", async () => {
    const { ev } = await sampleServer(null, "/no/such/path/for/agent-hq");
    expect([ev.disk_used, ev.disk_avail, ev.disk_size]).toEqual([null, null, null]);
  });

  it("HQ_SERVER_STATS and HQ_DISK_PATH", () => {
    expect(serverStatsEnabled({})).toBe(true);
    for (const v of ["0", "off", "FALSE", "no", " 0 "]) expect(serverStatsEnabled({ HQ_SERVER_STATS: v })).toBe(false);
    for (const v of ["1", "on", "yes", ""]) expect(serverStatsEnabled({ HQ_SERVER_STATS: v })).toBe(true);
    expect(diskPath({})).toBe("/");
    expect(diskPath({ HQ_DISK_PATH: " /data " })).toBe("/data");
  });
});

describe("hub and loop", () => {
  it("a sample is kept for new viewers, never as an agent", () => {
    expect(serverStatsForViewer()).toBeNull();
    publish({ type: "server_stats", cpu: 0.5 });
    expect(hub.agents.size).toBe(0);
    expect(hub.recent).toHaveLength(0);
    const v = serverStatsForViewer(hub.server.lastAt + 1200);
    expect(v).toMatchObject({ type: "server_stats", cpu: 0.5, age_ms: 1200 });
    expect(serverStatsForViewer(hub.server.lastAt + VIEWER_MAX_AGE_MS + 1)).toBeNull(); // too old (sampling stopped)
  });

  it("keeps 30 minutes of history; a new viewer gets the earlier samples with their age", () => {
    const sample = (cpu: number) => publish({ type: "server_stats", cpu, mem_used: 1, mem_total: 4, disk_used: 1, disk_avail: 3 });
    sample(0.1);
    sample(0.2);
    sample(0.3);
    const h = hub.server.history;
    expect(h.map((p) => [p.cpu, p.mem, p.disk])).toEqual([[0.1, 0.25, 0.25], [0.2, 0.25, 0.25], [0.3, 0.25, 0.25]]);
    const t = hub.server.lastAt;
    h[0].at = t - 10_000;
    h[1].at = t - 5000;
    const v = serverStatsForViewer(t + 1000)!;
    expect(v).toMatchObject({ cpu: 0.3, age_ms: 1000 });
    expect(v.history).toEqual([ // without the latest sample itself
      { age_ms: 11_000, cpu: 0.1, mem: 0.25, disk: 0.25 },
      { age_ms: 6000, cpu: 0.2, mem: 0.25, disk: 0.25 },
    ]);
    // older than 30 minutes is dropped, and never more than SERVER_HISTORY_MAX points
    h[0].at = Date.now() - SERVER_HISTORY_MS - 1000;
    sample(0.4);
    expect(hub.server.history.map((p) => p.cpu)).toEqual([0.2, 0.3, 0.4]);
    for (let i = 0; i < SERVER_HISTORY_MAX + 5; i++) sample(0.5);
    expect(hub.server.history).toHaveLength(SERVER_HISTORY_MAX);
  });

  it("an unknown value stays null in the history", () => {
    publish({ type: "server_stats", cpu: null });
    expect(hub.server.history).toMatchObject([{ cpu: null, mem: null, disk: null }]);
    const t = hub.server.lastAt;
    hub.server.history[0].at = t - 5000;
    publish({ type: "server_stats", cpu: 0.2 });
    expect(serverStatsForViewer()!.history).toMatchObject([{ cpu: null, mem: null, disk: null }]);
  });

  it("starts without a viewer, but not when turned off", () => {
    process.env.HQ_SERVER_STATS = "0";
    ensureServerStats();
    expect(hub.server.timer).toBeNull();
    delete process.env.HQ_SERVER_STATS;
    expect(hub.subs.size).toBe(0);
    ensureServerStats();
    expect(hub.server.timer).not.toBeNull();
  });

  it("samples without viewers and keeps them for the first viewer", async () => {
    ensureServerStats();
    const timer = hub.server.timer;
    expect(timer).not.toBeNull();
    ensureServerStats(); // a second call does not start a second loop
    expect(hub.server.timer).toBe(timer);
    await sleep(FIRST_SAMPLE_MS + 500);
    const last = hub.server.last!;
    expect(last.type).toBe("server_stats");
    expect(last.cpu).not.toBeUndefined();
    expect(typeof last.ts).toBe("string");
    expect(hub.server.history).toHaveLength(1);
    expect(hub.server.timer).not.toBeNull(); // next sample queued
    expect(serverStatsForViewer()).toMatchObject({ type: "server_stats", history: [] });
  }, 10_000);
});

describe("routes", () => {
  it("POST /api/event drops a posted server_stats (only the bridge measures)", async () => {
    const seen: BridgeEvent[] = [];
    hub.subs.add((ev) => seen.push(ev));
    const res = await postEvent(new Request("http://localhost:8787/api/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ type: "server_stats", cpu: 1 }, { id: "a", status: "working" }]),
    }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, received: 2 });
    expect(seen.map((e) => e.type ?? "agent_update")).toEqual(["agent_update"]);
    expect(hub.server.last).toBeNull();
    expect(listAgents().map((a) => a.id)).toEqual(["a"]);
  });

  it("GET /api/stream sends the latest sample after the snapshot and starts the loop if it is not running", async () => {
    publish({ type: "server_stats", cpu: 0.25, interval_ms: 5000 });
    const ctrl = new AbortController();
    const res = await getStream(new Request("http://localhost:8787/api/stream", { signal: ctrl.signal }));
    const it = sseFrames(res.body!);
    const first = await it.next();
    const second = await it.next();
    expect(JSON.parse(first.value!.data).type).toBe("snapshot");
    const ev = JSON.parse(second.value!.data);
    expect(ev).toMatchObject({ type: "server_stats", cpu: 0.25, history: [] });
    expect(ev.age_ms).toBeGreaterThanOrEqual(0);
    expect(hub.subs.size).toBe(1);
    expect(hub.server.timer).not.toBeNull();
    ctrl.abort();
    await it.return(undefined);
  });
});
