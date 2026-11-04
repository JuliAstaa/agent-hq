// Server monitor (prd.md §7.8): the machine Agent HQ runs on, measured by the bridge (lib/bridge/server-stats.ts).
// Types, normalization, levels, formatting and the warning rules shared by the store and the 3D server room.
// Pure functions only.

export interface ServerStats {
  /** process.platform of the bridge, e.g. "linux" or "win32". */
  platform: string;
  intervalMs: number;
  /** Busy share of all cores since the previous sample, 0..1. null = unknown. */
  cpu: number | null;
  cores: number | null;
  /** 1, 5, 15 minute load average. null on Windows (always zero there). */
  load: [number, number, number] | null;
  memUsed: number | null;
  memTotal: number | null;
  diskUsed: number | null;
  /** Free space for normal users (df "Avail"). */
  diskAvail: number | null;
  diskSize: number | null;
  uptimeS: number | null;
  /** Resident memory of the Agent HQ server process. */
  appRss: number | null;
  /** Local time (ms) of the sample, corrected by the bridge's age_ms. */
  receivedAt: number;
}

export const SERVER_INTERVAL_MS = 5000;
/** No sample for this long: the room shows "TERPUTUS". */
export const SERVER_STALE_MS = 20_000;
/** Log/agent id used for server warnings (like "SOC" for alerts). */
export const SERVER_LOG_ID = "Server";

/* ---------------- normalization ---------------- */

const num = (v: unknown): number | null => {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const frac = (v: unknown): number | null => {
  const n = num(v);
  if (n == null) return null;
  return n <= 1 ? n : n <= 100 ? n / 100 : null; // values above 1 are read as percent
};

/** Raw {"type":"server_stats"} event -> stats without receivedAt, plus the bridge's age of the sample. */
export function normalizeServerStats(ev: Record<string, unknown>): { stats: Omit<ServerStats, "receivedAt">; ageMs: number } {
  const load = Array.isArray(ev.load) ? ev.load.slice(0, 3).map(num) : [];
  const cores = num(ev.cores);
  const age = Number(ev.age_ms);
  return {
    stats: {
      platform: (ev.platform == null ? "" : String(ev.platform)).slice(0, 20),
      intervalMs: num(ev.interval_ms) || SERVER_INTERVAL_MS,
      cpu: frac(ev.cpu),
      cores: cores == null ? null : Math.round(cores),
      load: load.length === 3 && load.every((x) => x != null) ? (load as [number, number, number]) : null,
      memUsed: num(ev.mem_used),
      memTotal: num(ev.mem_total),
      diskUsed: num(ev.disk_used),
      diskAvail: num(ev.disk_avail),
      diskSize: num(ev.disk_size),
      uptimeS: num(ev.uptime_s),
      appRss: num(ev.app_rss),
    },
    ageMs: Number.isFinite(age) && age > 0 ? age : 0,
  };
}

/* ---------------- values and levels ---------------- */

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function memPct(s: ServerStats): number | null {
  return s.memUsed != null && s.memTotal ? clamp01(s.memUsed / s.memTotal) : null;
}

/** Like df: used / (used + avail), so space reserved for root counts as full. */
export function diskPct(s: ServerStats): number | null {
  if (s.diskUsed == null || s.diskAvail == null) return null;
  const t = s.diskUsed + s.diskAvail;
  return t > 0 ? clamp01(s.diskUsed / t) : null;
}

export type Level = "ok" | "mid" | "warn" | "hot";

export const LEVEL_COLOR: Record<Level, string> = { ok: "#a6e22e", mid: "#ffd23f", warn: "#ff9f1c", hot: "#ff4f5e" };
export const OFFLINE_COLOR = "#9a94b0";

export const levelOf = (p: number): Level => (p >= 0.9 ? "hot" : p >= 0.75 ? "warn" : p >= 0.5 ? "mid" : "ok");

export const serverStale = (s: ServerStats, now: number) => now - s.receivedAt > Math.max(SERVER_STALE_MS, 3 * s.intervalMs);

/** Header state of the server screen. */
export function serverState(s: ServerStats, now: number): { label: string; color: string } {
  if (serverStale(s, now)) return { label: "TERPUTUS", color: LEVEL_COLOR.hot };
  const top = Math.max(0, ...[s.cpu, memPct(s), diskPct(s)].filter((x): x is number => x != null));
  if (top >= 0.9) return { label: "KRITIS", color: LEVEL_COLOR.hot };
  if (top >= 0.75) return { label: "SIBUK", color: LEVEL_COLOR.warn };
  return { label: "NORMAL", color: LEVEL_COLOR.ok };
}

/* ---------------- formatting ---------------- */

export const pctText = (p: number) => `${Math.round(p * 100)}%`;

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
/** Binary units like `free -h` and `df -h`: "820 MB", "2.4 GB", "40 GB". */
export function fmtBytes(n: number): string {
  let v = Math.max(0, n), u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)} ${UNITS[u]}`;
}

/** "2.4 / 3.8 GB": both values in the unit of the total. */
export function fmtPair(used: number, total: number): string {
  let u = 0, t = Math.max(0, total);
  while (t >= 1024 && u < UNITS.length - 1) {
    t /= 1024;
    u++;
  }
  const k = 1024 ** u;
  const f = (x: number) => (x / k < 10 && u > 0 ? (x / k).toFixed(1) : String(Math.round(x / k)));
  return `${f(Math.max(0, used))} / ${f(Math.max(0, total))} ${UNITS[u]}`;
}

/** Uptime in the board style: "< 1m", "45m", "3j 12m", "12h 4j". */
export function fmtUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return "< 1m";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}j ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}h ${Math.floor((s % 86400) / 3600)}j`;
}

/* ---------------- warnings ---------------- */

export type Watch = "cpu" | "mem" | "disk";
export const WATCHES: Watch[] = ["cpu", "mem", "disk"];

/** Per-viewer warning state (kept by the store, reset with the connection). */
export interface ServerAlarm {
  on: Record<Watch, boolean>;
  /** receivedAt of the first sample in the current run of CPU samples at or above HOT. */
  cpuHighSince: number | null;
}

export const ALARM_HOT = 0.9;
/** A warning clears below this (hysteresis, so a value around 90% does not flap). */
export const ALARM_CLEAR = 0.85;
export const CPU_HOT_FOR_MS = 60_000;

export const newServerAlarm = (): ServerAlarm => ({ on: { cpu: false, mem: false, disk: false }, cpuHighSince: null });

export interface AlarmNote {
  watch: Watch;
  level: "warn" | "info";
  log: string;
  /** Only when a warning starts. */
  toast?: string;
}

const LABEL: Record<Watch, string> = { cpu: "CPU", mem: "RAM", disk: "Disk" };

/** Apply one sample to `alarm` (mutated) and return the log lines and toasts it causes, in WATCHES order. */
export function checkServerAlarm(alarm: ServerAlarm, s: ServerStats): AlarmNote[] {
  const notes: AlarmNote[] = [];
  const values: Record<Watch, number | null> = { cpu: s.cpu, mem: memPct(s), disk: diskPct(s) };
  if (s.cpu != null) {
    if (s.cpu < ALARM_HOT) alarm.cpuHighSince = null;
    else alarm.cpuHighSince ??= s.receivedAt;
  }
  for (const w of WATCHES) {
    const p = values[w];
    if (p == null) continue;
    const pct = pctText(p);
    if (!alarm.on[w]) {
      const hot = w === "cpu" ? alarm.cpuHighSince != null && s.receivedAt - alarm.cpuHighSince >= CPU_HOT_FOR_MS : p >= ALARM_HOT;
      if (!hot) continue;
      alarm.on[w] = true;
      if (w === "cpu") notes.push({ watch: w, level: "warn", log: `CPU server ${pct} selama 1 menit`, toast: `Server sibuk: CPU ${pct} selama 1 menit` });
      else {
        const pair = w === "mem" ? (s.memTotal ? fmtPair(s.memUsed ?? 0, s.memTotal) : "") : s.diskSize ? fmtPair(s.diskUsed ?? 0, s.diskSize) : "";
        notes.push({
          watch: w,
          level: "warn",
          log: `${LABEL[w]} server hampir penuh: ${pct}${pair ? ` (${pair})` : ""}`,
          toast: `Server: ${w === "mem" ? "RAM" : "disk"} hampir penuh (${pct})`,
        });
      }
    } else if (p < ALARM_CLEAR) {
      alarm.on[w] = false;
      notes.push({ watch: w, level: "info", log: `${LABEL[w]} server normal lagi: ${pct}` });
    }
  }
  return notes;
}
