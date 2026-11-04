// Server monitor, office side (lib/server.ts, prd.md §7.8): normalization, levels, formatting, warnings, history and
// chart geometry for the Server panel, and the store flow (state, history, redraw signal, log lines and toasts, reset
// with the connection).
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeEvent } from "@/lib/events";
import {
  chartLines, chartRange, chartXY, checkServerAlarm, diskPct, fmtBytes, fmtPair, fmtUptime, levelOf, memPct, newServerAlarm,
  normalizeServerStats, SERVER_HISTORY_MAX, SERVER_HISTORY_MS, serverPoint, serverStale, serverState, trimHistory,
  type ServerPoint, type ServerStats,
} from "@/lib/server";
import { litRows } from "@/engine/displays/server";
import { createDemo } from "@/lib/demo";
import { createHQStore, type HQStore, type Signal } from "@/lib/store";

const GB = 1024 ** 3;
const RAW = {
  type: "server_stats", platform: "linux", interval_ms: 5000, cpu: 0.42, cores: 4, load: [0.52, 0.4, 0.31],
  mem_used: 2.4 * GB, mem_total: 3.8 * GB, disk_used: 29 * GB, disk_avail: 9 * GB, disk_size: 40 * GB,
  uptime_s: 1036800, app_rss: 210 * 1024 ** 2,
};
const stats = (over: Partial<ServerStats> = {}): ServerStats => ({ ...normalizeServerStats(RAW).stats, receivedAt: 0, ...over });

describe("normalizeServerStats", () => {
  it("reads every field", () => {
    expect(normalizeServerStats({ ...RAW, age_ms: 1200 })).toEqual({
      stats: {
        platform: "linux", intervalMs: 5000, cpu: 0.42, cores: 4, load: [0.52, 0.4, 0.31], memUsed: 2.4 * GB, memTotal: 3.8 * GB,
        diskUsed: 29 * GB, diskAvail: 9 * GB, diskSize: 40 * GB, uptimeS: 1036800, appRss: 210 * 1024 ** 2,
      },
      ageMs: 1200,
      history: null,
    });
  });

  it("reads the history of a sample for a new viewer, oldest first, skipping bad points", () => {
    const { history } = normalizeServerStats({
      ...RAW,
      history: [
        { age_ms: 10_000, cpu: 0.2, mem: 0.5, disk: 0.6 },
        { age_ms: 20_000, cpu: 50, mem: null, disk: "x" },
        null,
        "x",
        { cpu: 0.1 }, // no age
      ],
    });
    expect(history).toEqual([
      { ageMs: 20_000, cpu: 0.5, mem: null, disk: null },
      { ageMs: 10_000, cpu: 0.2, mem: 0.5, disk: 0.6 },
    ]);
    expect(normalizeServerStats({ ...RAW, history: "x" }).history).toBeNull();
    const many = Array.from({ length: SERVER_HISTORY_MAX + 50 }, (_, i) => ({ age_ms: i * 5000, cpu: 0.1 }));
    expect(normalizeServerStats({ ...RAW, history: many }).history).toHaveLength(SERVER_HISTORY_MAX);
  });

  it("missing or odd values become null, percent CPU is read as a share", () => {
    const { stats: s, ageMs } = normalizeServerStats({ type: "server_stats", cpu: 87, load: null, mem_used: "x", mem_total: -1, disk_used: true, age_ms: "?" });
    expect(s).toMatchObject({ platform: "", intervalMs: 5000, cpu: 0.87, cores: null, load: null, memUsed: null, memTotal: null, diskUsed: null });
    expect(ageMs).toBe(0);
    expect(normalizeServerStats({ cpu: 250 }).stats.cpu).toBeNull();
    expect(normalizeServerStats({ load: [1, 2] }).stats.load).toBeNull();
  });

  it("is its own event kind, never an agent", () => {
    const out = normalizeEvent(RAW);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("server_stats");
  });
});

describe("values, levels, formatting", () => {
  it("memory and disk shares (disk like df: used / (used + avail))", () => {
    expect(memPct(stats())).toBeCloseTo(2.4 / 3.8);
    expect(diskPct(stats())).toBeCloseTo(29 / 38);
    expect(memPct(stats({ memTotal: 0 }))).toBeNull();
    expect(diskPct(stats({ diskAvail: null }))).toBeNull();
  });

  it("levels at 50, 75 and 90%", () => {
    expect([0, 0.49, 0.5, 0.74, 0.75, 0.89, 0.9, 1].map(levelOf)).toEqual(["ok", "ok", "mid", "mid", "warn", "warn", "hot", "hot"]);
  });

  it("screen state: NORMAL, SIBUK, KRITIS, TERPUTUS", () => {
    expect(serverState(stats({ cpu: 0.2, memUsed: GB, diskUsed: GB }), 1000).label).toBe("NORMAL");
    expect(serverState(stats(), 1000).label).toBe("SIBUK"); // disk 76%
    expect(serverState(stats({ cpu: 0.95 }), 1000).label).toBe("KRITIS");
    expect(serverStale(stats(), 20_000)).toBe(false);
    expect(serverStale(stats(), 20_001)).toBe(true);
    expect(serverState(stats(), 60_000).label).toBe("TERPUTUS");
    expect(serverStale(stats({ intervalMs: 30_000 }), 60_000)).toBe(false); // slower samples wait longer
  });

  it("bytes, pairs and uptime", () => {
    expect(fmtBytes(210 * 1024 ** 2)).toBe("210 MB");
    expect(fmtBytes(2.4 * GB)).toBe("2.4 GB");
    expect(fmtBytes(40 * GB)).toBe("40 GB");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtPair(2.4 * GB, 3.8 * GB)).toBe("2.4 / 3.8 GB");
    expect(fmtPair(29 * GB, 40 * GB)).toBe("29 / 40 GB");
    expect(fmtPair(300 * 1024 ** 2, 900 * 1024 ** 2)).toBe("300 / 900 MB");
    expect([30, 59 * 60, 3 * 3600 + 12 * 60, 12 * 86400 + 4 * 3600].map(fmtUptime)).toEqual(["< 1m", "59m", "3j 12m", "12h 4j"]);
  });

  it("lit LED rows: at least one, at most six", () => {
    expect([0, 0.1, 0.17, 0.5, 0.51, 0.99, 1].map((p) => litRows(p))).toEqual([1, 1, 2, 3, 4, 6, 6]);
  });
});

describe("history and charts", () => {
  const pt = (at: number, cpu: number | null): ServerPoint => ({ at, cpu, mem: 0.5, disk: 0.6 });

  it("a history point holds the shares of a sample", () => {
    expect(serverPoint(stats({ receivedAt: 7 }))).toEqual({ at: 7, cpu: 0.42, mem: memPct(stats())!, disk: diskPct(stats())! });
  });

  it("keeps the last 30 minutes, at most SERVER_HISTORY_MAX points", () => {
    const now = 10 * SERVER_HISTORY_MS;
    const pts = [pt(now - SERVER_HISTORY_MS - 1, 0.1), pt(now - SERVER_HISTORY_MS, 0.2), pt(now, 0.3)];
    expect(trimHistory(pts, now).map((p) => p.cpu)).toEqual([0.2, 0.3]);
    const kept = [pt(now, 0.3)];
    expect(trimHistory(kept, now)).toBe(kept); // nothing to drop: same array
    const many = Array.from({ length: SERVER_HISTORY_MAX + 3 }, (_, i) => pt(now - i, 0.1)).reverse();
    expect(trimHistory(many, now)).toHaveLength(SERVER_HISTORY_MAX);
    expect(trimHistory(many, now).at(-1)!.at).toBe(now);
  });

  it("chart: 30 minutes across, 0% at the bottom; the line breaks at gaps and unknown values", () => {
    const t1 = 10 * SERVER_HISTORY_MS, W = 300, H = 50;
    expect(chartXY(t1, 1, t1, W, H)).toEqual([300, 0]);
    expect(chartXY(t1 - SERVER_HISTORY_MS, 0, t1, W, H)).toEqual([0, 50]);
    expect(chartXY(t1 - SERVER_HISTORY_MS / 2, 0.5, t1, W, H)).toEqual([150, 25]);
    expect(chartXY(t1, 1.5, t1, W, H)).toEqual([300, 0]); // clamped
    const pts = [
      pt(t1 - SERVER_HISTORY_MS - 5000, 0.9), // outside the window
      pt(t1 - 60_000, 0.2),
      pt(t1 - 55_000, 0.4),
      pt(t1 - 50_000, null), // unknown: break
      pt(t1 - 45_000, 0.4),
      pt(t1 - 10_000, 0.6), // 35 s after the previous sample: break
      pt(t1 - 5000, 0.8),
    ];
    const runs = chartLines(pts, "cpu", t1, W, H, 15_000);
    expect(runs.map((r) => r.length)).toEqual([2, 1, 2]);
    expect(runs[0][0]).toEqual(chartXY(t1 - 60_000, 0.2, t1, W, H));
    expect(chartLines(pts, "mem", t1, W, H, 15_000).map((r) => r.length)).toEqual([4, 2]); // no unknown values: only the gap breaks
    expect(chartLines([], "cpu", t1, W, H, 15_000)).toEqual([]);
    expect(chartRange(pts, "cpu")).toEqual({ min: 0.2, max: 0.9 });
    expect(chartRange([pt(0, null)], "cpu")).toBeNull();
  });
});

describe("warnings", () => {
  it("RAM and disk warn at 90% and clear below 85%", () => {
    const a = newServerAlarm();
    expect(checkServerAlarm(a, stats({ memUsed: 3.3 * GB }))).toEqual([]); // 87%
    expect(checkServerAlarm(a, stats({ memUsed: 3.5 * GB }))).toEqual([
      { watch: "mem", level: "warn", log: "RAM server hampir penuh: 92% (3.5 / 3.8 GB)", toast: "Server: RAM hampir penuh (92%)" },
    ]);
    expect(checkServerAlarm(a, stats({ memUsed: 3.5 * GB }))).toEqual([]); // once
    expect(checkServerAlarm(a, stats({ memUsed: 3.3 * GB }))).toEqual([]); // 87%: still on (hysteresis)
    expect(checkServerAlarm(a, stats({ memUsed: 3.0 * GB }))).toEqual([{ watch: "mem", level: "info", log: "RAM server normal lagi: 79%" }]);
    expect(checkServerAlarm(a, stats({ diskUsed: 36 * GB, diskAvail: 2 * GB }))).toEqual([
      { watch: "disk", level: "warn", log: "Disk server hampir penuh: 95% (36 / 40 GB)", toast: "Server: disk hampir penuh (95%)" },
    ]);
  });

  it("CPU warns only after 60 s at 90% or more", () => {
    const a = newServerAlarm();
    const cpu = (cpu: number, at: number) => checkServerAlarm(a, stats({ cpu, receivedAt: at }));
    expect(cpu(0.95, 0)).toEqual([]);
    expect(cpu(0.97, 55_000)).toEqual([]);
    expect(cpu(0.6, 58_000)).toEqual([]); // a dip restarts the minute
    expect(cpu(0.95, 60_000)).toEqual([]);
    expect(cpu(0.95, 115_000)).toEqual([]);
    expect(cpu(0.96, 120_000)).toEqual([{ watch: "cpu", level: "warn", log: "CPU server 96% selama 1 menit", toast: "Server sibuk: CPU 96% selama 1 menit" }]);
    expect(cpu(0.88, 125_000)).toEqual([]);
    expect(cpu(0.4, 130_000)).toEqual([{ watch: "cpu", level: "info", log: "CPU server normal lagi: 40%" }]);
  });

  it("unknown values change nothing", () => {
    const a = newServerAlarm();
    expect(checkServerAlarm(a, stats({ cpu: null, memUsed: null, diskUsed: null }))).toEqual([]);
    expect(a).toEqual(newServerAlarm());
  });
});

describe("store", () => {
  let store: HQStore;
  let signals: Signal[];
  const S = () => store.getState();
  beforeEach(() => {
    store = createHQStore();
    signals = [];
    S().onSignal((s) => signals.push(s));
  });

  it("keeps the latest sample (age corrected), signals a redraw, adds no agent", () => {
    const before = Date.now();
    S().applyEvent({ ...RAW, age_ms: 2000 });
    const s = S().server!;
    expect(s).toMatchObject({ cpu: 0.42, cores: 4, memTotal: 3.8 * GB });
    expect(s.receivedAt).toBeLessThanOrEqual(Date.now() - 2000);
    expect(s.receivedAt).toBeGreaterThanOrEqual(before - 2000);
    expect(signals).toEqual([{ type: "server" }]);
    expect(S().agents.size).toBe(0);
    expect(S().logs).toEqual([]);
  });

  it("a warning becomes a log line under Server and a toast", () => {
    S().applyEvent({ ...RAW, mem_used: 3.6 * GB, disk_used: 37 * GB, disk_avail: 1 * GB });
    expect(S().logs.map((l) => `${l.level}|${l.name}|${l.message}`)).toEqual([
      "warn|Server|RAM server hampir penuh: 95% (3.6 / 3.8 GB)",
      "warn|Server|Disk server hampir penuh: 97% (37 / 40 GB)",
    ]);
    expect(S().toast?.msg).toBe("Server: RAM hampir penuh (95%)");
    S().applyEvent({ ...RAW });
    expect(S().logs.slice(2).map((l) => l.message)).toEqual(["RAM server normal lagi: 63%", "Disk server normal lagi: 76%"]);
  });

  it("history: the first sample of a connection brings the bridge's history, live samples add to it", () => {
    const now = Date.now();
    S().applyEvent({ ...RAW, age_ms: 1000, history: [{ age_ms: 11_000, cpu: 0.1, mem: 0.2, disk: 0.3 }, { age_ms: 6000, cpu: 0.2, mem: 0.2, disk: 0.3 }] });
    const h = S().serverHistory;
    expect(h.map((p) => p.cpu)).toEqual([0.1, 0.2, 0.42]);
    expect(h[0].at).toBeGreaterThanOrEqual(now - 11_000);
    expect(h[0].at).toBeLessThanOrEqual(Date.now() - 11_000);
    expect(h[2]).toEqual(serverPoint(S().server!));
    S().applyEvent({ ...RAW, cpu: 0.5 });
    expect(S().serverHistory.map((p) => p.cpu)).toEqual([0.1, 0.2, 0.42, 0.5]);
    S().applyEvent({ ...RAW, cpu: 0.6, history: [] }); // a reconnect: the bridge's history replaces the page's
    expect(S().serverHistory.map((p) => p.cpu)).toEqual([0.6]);
  });

  it("a new connection or the demo clears it (decor again) and rearms the warnings", () => {
    S().applyEvent({ ...RAW, mem_used: 3.6 * GB });
    S().clearAgents();
    expect(S().server).toBeNull();
    expect(S().serverHistory).toEqual([]);
    expect(signals.filter((s) => s.type === "server")).toHaveLength(2);
    S().applyEvent({ ...RAW, mem_used: 3.6 * GB });
    expect(S().logs.filter((l) => l.name === "Server")).toHaveLength(1); // logs were cleared, warned again
    const demo = createDemo(store);
    demo.start();
    demo.stop();
    expect(S().server).toBeNull();
  });
});
