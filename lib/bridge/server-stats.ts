// Server monitor (prd.md §7.8): measure the machine Agent HQ runs on with Node built-ins and publish
// {"type":"server_stats"} every 5 s while someone watches the stream. Read only: no command is ever run, and no
// host name, address, user or process list leaves the server.

import { promises as fsp } from "node:fs";
import os from "node:os";
import { hub, publish, type BridgeEvent } from "./hub";

export const SAMPLE_MS = 5000;
/** CPU busy share needs two readings: the first sample comes this long after the loop starts. */
export const FIRST_SAMPLE_MS = 1000;
/** A stored sample older than this is not sent to new viewers (the loop was stopped without viewers). */
export const VIEWER_MAX_AGE_MS = 3 * SAMPLE_MS;

export interface CpuTimes {
  idle: number;
  total: number;
}

/** HQ_SERVER_STATS=0 (or off, false, no) turns sampling off. */
export const serverStatsEnabled = (env: Record<string, string | undefined> = process.env) =>
  !/^(0|off|false|no)$/i.test(String(env.HQ_SERVER_STATS ?? "").trim());

export const diskPath = (env: Record<string, string | undefined> = process.env) => String(env.HQ_DISK_PATH || "").trim() || "/";

/** Summed CPU times of all cores (ms). */
export function cpuTimes(cpus: os.CpuInfo[] = os.cpus()): CpuTimes {
  let idle = 0, total = 0;
  for (const { times: t } of cpus) {
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Busy share of all cores between two readings, 0..1; null without a previous reading or elapsed time. */
export function cpuBusy(prev: CpuTimes | null, cur: CpuTimes): number | null {
  if (!prev) return null;
  const dt = cur.total - prev.total;
  if (!(dt > 0)) return null;
  return Math.max(0, Math.min(1, 1 - (cur.idle - prev.idle) / dt));
}

/** MemTotal and MemAvailable (bytes) from /proc/meminfo; null when either is missing (old kernels). */
export function parseMeminfo(text: string): { total: number; avail: number } | null {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb("MemTotal"), avail = kb("MemAvailable");
  return total && avail != null ? { total, avail } : null;
}

async function memory(): Promise<{ used: number; total: number }> {
  // os.freemem() is MemFree on older Node versions, which counts the page cache as used; MemAvailable does not.
  if (process.platform === "linux") {
    try {
      const m = parseMeminfo(await fsp.readFile("/proc/meminfo", "utf8"));
      if (m) return { used: Math.max(0, m.total - m.avail), total: m.total };
    } catch {}
  }
  const total = os.totalmem();
  return { used: Math.max(0, total - os.freemem()), total };
}

async function disk(path: string): Promise<{ used: number; avail: number; size: number } | null> {
  try {
    const s = await fsp.statfs(path);
    return { used: (s.blocks - s.bfree) * s.bsize, avail: s.bavail * s.bsize, size: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

const round = (n: number | null, d: number) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** One sample. `prev` is the CPU reading of the previous sample; the new reading is returned with the event. */
export async function sampleServer(prev: CpuTimes | null, path = diskPath()): Promise<{ ev: BridgeEvent; cpu: CpuTimes }> {
  const cpu = cpuTimes();
  const [mem, dk] = await Promise.all([memory(), disk(path)]);
  const ev: BridgeEvent = {
    type: "server_stats",
    platform: process.platform,
    interval_ms: SAMPLE_MS,
    cpu: round(cpuBusy(prev, cpu), 3),
    cores: os.availableParallelism(),
    load: process.platform === "win32" ? null : os.loadavg().map((x) => round(x, 2)),
    mem_used: mem.used,
    mem_total: mem.total,
    disk_used: dk?.used ?? null,
    disk_avail: dk?.avail ?? null,
    disk_size: dk?.size ?? null,
    uptime_s: Math.round(os.uptime()),
    app_rss: process.memoryUsage.rss(),
  };
  return { ev, cpu };
}

/** The latest sample for a new viewer, with its age; null when there is none or it is old. */
export function serverStatsForViewer(now = Date.now()): BridgeEvent | null {
  const s = hub.server;
  if (!s.last || now - s.lastAt > VIEWER_MAX_AGE_MS) return null;
  return { ...s.last, age_ms: Math.max(0, now - s.lastAt) };
}

async function tick(): Promise<void> {
  const s = hub.server;
  if (!hub.subs.size || !serverStatsEnabled()) {
    s.timer = null; // nobody watches: stop until the next viewer
    s.prev = null;
    return;
  }
  try {
    const { ev, cpu } = await sampleServer(s.prev);
    s.prev = cpu;
    if (hub.server === s && hub.subs.size) publish(ev);
  } catch {}
  if (hub.server !== s) return; // the hub was reset meanwhile (tests)
  s.timer = setTimeout(tick, SAMPLE_MS);
  s.timer.unref?.();
}

/** Start the sampling loop if a viewer is connected and it is not running yet (called by the stream route). */
export function ensureServerStats(): void {
  const s = hub.server;
  if (s.timer || !hub.subs.size || !serverStatsEnabled()) return;
  s.prev = cpuTimes();
  s.timer = setTimeout(tick, FIRST_SAMPLE_MS);
  s.timer.unref?.();
}
