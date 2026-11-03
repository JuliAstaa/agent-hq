// Scheduled jobs (Hermes cron, docs/hermes.md "Jadwal"): types, normalization, and display helpers shared by the
// store, the 3D schedule board, and the control panel. Pure functions only.

export type CronAction = "run" | "pause" | "resume";
export const CRON_ACTIONS: CronAction[] = ["run", "pause", "resume"];

export const CRON_ACTION_LABEL: Record<CronAction, string> = {
  run: "Jalankan sekarang",
  pause: "Jeda",
  resume: "Lanjutkan",
};

export interface CronJob {
  id: string;
  name: string;
  /** Human schedule as the source shows it, e.g. "every 30m" or "0 9 * * 1-5". */
  schedule: string;
  /** Epoch ms, null when there is no next run (paused, finished one-shot). */
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: "ok" | "error" | null;
  lastError: string;
  /** Source state: scheduled, paused, completed, error, ... */
  state: string;
  enabled: boolean;
  running: boolean;
  failureStreak: number;
  /** Where the result goes (platform only, e.g. "telegram" or "local"). */
  deliver: string;
}

export interface CronState {
  source: string;
  /** Actions the source accepts from the panel. Empty = view only. */
  controls: CronAction[];
  schedulerAlive: boolean;
  /** The reporter said goodbye (stopped). */
  offline: boolean;
  jobs: CronJob[];
  /** Local time (ms) the snapshot was taken, corrected by the bridge's age_ms. */
  receivedAt: number;
}

export type CronCmdStatus = "queued" | "sent" | "ok" | "error";

export interface CronCmd {
  id: string;
  action: CronAction;
  job: string;
  jobName: string;
  status: CronCmdStatus;
  message: string;
  at: number;
}

/** DOM event (bubbling, from the 3D stage) when the schedule board is clicked: the office opens the panel. */
export const CRON_BOARD_EVENT = "agenthq:cron-board";

/** A schedule older than this (no heartbeat from the reporter) counts as disconnected. */
export const CRON_STALE_MS = 90_000;
export const MAX_CRON_JOBS = 50;

const str = (v: unknown, n: number) => (v == null ? "" : String(v)).replace(/\s+/g, " ").trim().slice(0, n);
const time = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const isAction = (v: unknown): v is CronAction => typeof v === "string" && (CRON_ACTIONS as string[]).includes(v);

/** Raw {"type":"schedule"} event -> state without receivedAt, plus the bridge's age of the snapshot. */
export function normalizeSchedule(ev: Record<string, unknown>): { cron: Omit<CronState, "receivedAt">; ageMs: number } {
  const sched = (ev.scheduler && typeof ev.scheduler === "object" ? ev.scheduler : {}) as Record<string, unknown>;
  const jobs: CronJob[] = [];
  for (const j of Array.isArray(ev.jobs) ? ev.jobs.slice(0, MAX_CRON_JOBS) : []) {
    if (!j || typeof j !== "object") continue;
    const r = j as Record<string, unknown>;
    const id = str(r.id, 64);
    if (!id) continue;
    const ls = str(r.last_status, 20).toLowerCase();
    jobs.push({
      id,
      name: str(r.name, 60) || id,
      schedule: str(r.schedule, 40),
      nextRunAt: time(r.next_run_at),
      lastRunAt: time(r.last_run_at),
      lastStatus: ls === "error" || ls === "failed" ? "error" : ls ? "ok" : null,
      lastError: str(r.last_error, 200),
      state: str(r.state, 20).toLowerCase() || "scheduled",
      enabled: r.enabled !== false,
      running: r.running === true,
      failureStreak: Math.max(0, Math.floor(Number(r.failure_streak) || 0)),
      deliver: str(r.deliver, 30),
    });
  }
  const age = Number(ev.age_ms);
  return {
    cron: {
      source: str(ev.source, 40) || "cron",
      controls: Array.isArray(ev.controls) ? ev.controls.filter(isAction) : [],
      schedulerAlive: sched.alive !== false,
      offline: ev.offline === true,
      jobs,
    },
    ageMs: Number.isFinite(age) && age > 0 ? age : 0,
  };
}

/** Raw {"type":"cron_command"} event -> command, null when malformed. */
export function normalizeCronCommand(ev: Record<string, unknown>): CronCmd | null {
  const id = str(ev.id, 40);
  const status = str(ev.status, 10) as CronCmdStatus;
  if (!id || !isAction(ev.action) || !["queued", "sent", "ok", "error"].includes(status)) return null;
  return { id, action: ev.action, job: str(ev.job, 64), jobName: str(ev.job_name, 60) || str(ev.job, 64), status, message: str(ev.message, 200), at: Date.now() };
}

/* ---------------- display ---------------- */

export type JobPhase = "running" | "due" | "scheduled" | "paused" | "done" | "error";

export const PHASE: Record<JobPhase, { label: string; color: string }> = {
  running: { label: "Jalan", color: "#a6e22e" },
  due: { label: "Segera", color: "#ffd23f" },
  scheduled: { label: "Terjadwal", color: "#59c3ff" },
  paused: { label: "Jeda", color: "#9a94b0" },
  done: { label: "Selesai", color: "#c3a6ff" },
  error: { label: "Gagal", color: "#ff4f5e" },
};

export function jobPhase(j: CronJob, now: number): JobPhase {
  if (j.running) return "running";
  if (!j.enabled || j.state === "paused") return "paused";
  if (j.state === "completed") return "done";
  if (j.state === "error" || j.lastStatus === "error") return "error";
  if (j.nextRunAt != null && j.nextRunAt - now < 60_000) return "due";
  return "scheduled";
}

/** Time until the next run, short enough for the board: "45 dtk", "12:05", "3j 12m", "2h 5j". */
export function countdown(nextRunAt: number | null, now: number): string {
  if (nextRunAt == null) return "-";
  const s = Math.round((nextRunAt - now) / 1000);
  if (s <= 0) return "sekarang";
  if (s < 60) return `${s} dtk`;
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  if (s < 86400) return `${Math.floor(s / 3600)}j ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}h ${Math.floor((s % 86400) / 3600)}j`;
}

/** "baru saja", "5 mnt lalu", "3 jam lalu", "2 hari lalu". */
export function ago(t: number | null, now: number): string {
  if (t == null) return "belum pernah";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "baru saja";
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}

/** No heartbeat for CRON_STALE_MS, or the reporter stopped. */
export const cronStale = (c: CronState, now: number) => c.offline || now - c.receivedAt > CRON_STALE_MS;

/** Jobs in board order: running first, then by next run (none last), then by name. */
export function sortJobs(jobs: CronJob[]): CronJob[] {
  return jobs.slice().sort((a, b) =>
    Number(b.running) - Number(a.running)
    || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)
    || a.name.localeCompare(b.name));
}

/** Control endpoint next to the live stream: /api/stream -> /api/cron. Other stream URLs have no controls. */
export function cronUrlFor(streamUrl: string | null, base: string): string | null {
  if (!streamUrl) return null;
  let u: URL;
  try {
    u = new URL(streamUrl, base);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !/\/api\/stream\/?$/.test(u.pathname)) return null;
  u.pathname = u.pathname.replace(/\/stream\/?$/, "/cron");
  u.search = "";
  u.hash = "";
  return u.toString();
}
