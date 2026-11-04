// Server monitor, office side (lib/server.ts, prd.md §7.8): normalization, levels, formatting, warnings, and the
// store flow (state, redraw signal, log lines and toasts, reset with the connection).
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeEvent } from "@/lib/events";
import {
  checkServerAlarm, diskPct, fmtBytes, fmtPair, fmtUptime, levelOf, memPct, newServerAlarm, normalizeServerStats,
  serverStale, serverState, type ServerStats,
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
    });
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

  it("a new connection or the demo clears it (decor again) and rearms the warnings", () => {
    S().applyEvent({ ...RAW, mem_used: 3.6 * GB });
    S().clearAgents();
    expect(S().server).toBeNull();
    expect(signals.filter((s) => s.type === "server")).toHaveLength(2);
    S().applyEvent({ ...RAW, mem_used: 3.6 * GB });
    expect(S().logs.filter((l) => l.name === "Server")).toHaveLength(1); // logs were cleared, warned again
    const demo = createDemo(store);
    demo.start();
    demo.stop();
    expect(S().server).toBeNull();
  });
});
