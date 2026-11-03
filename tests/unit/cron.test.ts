// Scheduled jobs (Hermes cron): lib/cron.ts helpers, event normalization, and the store's schedule state.
import { describe, expect, it } from "vitest";
import {
  ago, countdown, cronStale, cronUrlFor, jobPhase, normalizeCronCommand, normalizeSchedule, sortJobs,
  CRON_STALE_MS, type CronJob, type CronState,
} from "@/lib/cron";
import { normalizeEvent } from "@/lib/events";
import { createHQStore, CRON_LOG_ID, type Signal } from "@/lib/store";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const job = (p: Partial<CronJob> = {}): CronJob => ({
  id: "a1b2c3d4e5f6", name: "Laporan", schedule: "0 9 * * *", nextRunAt: NOW + 3600e3, lastRunAt: null, lastStatus: null,
  lastError: "", state: "scheduled", enabled: true, running: false, failureStreak: 0, deliver: "", ...p,
});
const RAW = {
  type: "schedule", source: "Hermes di vps", controls: ["run", "pause", "resume", "rm -rf"], scheduler: { alive: true },
  jobs: [
    { id: "a1b2c3d4e5f6", name: "Laporan harian", schedule: "0 9 * * *", next_run_at: NOW + 3600e3, last_run_at: "2026-11-03T09:00:00Z", last_status: "ok", state: "scheduled", enabled: true, running: false, failure_streak: 0, deliver: "telegram" },
    { id: "0f9e8d7c6b5a", name: "Cek SSH", schedule: "every 30m", next_run_at: null, last_status: "error", last_error: "boom", state: "paused", enabled: false, failure_streak: 3 },
    { name: "tanpa id" },
    "rusak",
  ],
};

describe("normalizeSchedule", () => {
  it("keeps valid jobs and known actions, parses times (epoch ms and ISO)", () => {
    const { cron, ageMs } = normalizeSchedule({ ...RAW, age_ms: 4000 });
    expect(ageMs).toBe(4000);
    expect(cron).toMatchObject({ source: "Hermes di vps", controls: ["run", "pause", "resume"], schedulerAlive: true, offline: false });
    expect(cron.jobs).toHaveLength(2);
    expect(cron.jobs[0]).toMatchObject({ id: "a1b2c3d4e5f6", nextRunAt: NOW + 3600e3, lastRunAt: Date.parse("2026-11-03T09:00:00Z"), lastStatus: "ok", deliver: "telegram" });
    expect(cron.jobs[1]).toMatchObject({ enabled: false, state: "paused", lastStatus: "error", lastError: "boom", failureStreak: 3, nextRunAt: null });
  });
  it("odd input is safe: no jobs, no controls, view only", () => {
    expect(normalizeSchedule({ type: "schedule", jobs: "x", controls: "run" }).cron).toMatchObject({ jobs: [], controls: [], source: "cron" });
  });
  it("seconds are read as seconds", () => {
    expect(normalizeSchedule({ jobs: [{ id: "x", next_run_at: 1_800_000_000 }] }).cron.jobs[0].nextRunAt).toBe(1_800_000_000_000);
  });
});

describe("normalizeCronCommand", () => {
  it("valid command", () => {
    expect(normalizeCronCommand({ id: "c-1", action: "run", job: "abc", job_name: "Laporan", status: "ok", message: "jalan" })).toMatchObject({ id: "c-1", action: "run", jobName: "Laporan", status: "ok" });
  });
  it("rejects unknown actions and statuses", () => {
    expect(normalizeCronCommand({ id: "c-1", action: "remove", job: "abc", status: "ok" })).toBeNull();
    expect(normalizeCronCommand({ id: "c-1", action: "run", job: "abc", status: "weird" })).toBeNull();
  });
});

describe("display helpers", () => {
  it("phase", () => {
    expect(jobPhase(job({ running: true, enabled: false }), NOW)).toBe("running");
    expect(jobPhase(job({ enabled: false }), NOW)).toBe("paused");
    expect(jobPhase(job({ state: "completed" }), NOW)).toBe("done");
    expect(jobPhase(job({ lastStatus: "error" }), NOW)).toBe("error");
    expect(jobPhase(job({ nextRunAt: NOW + 30e3 }), NOW)).toBe("due");
    expect(jobPhase(job(), NOW)).toBe("scheduled");
  });
  it("countdown", () => {
    expect(countdown(null, NOW)).toBe("-");
    expect(countdown(NOW - 5e3, NOW)).toBe("sekarang");
    expect(countdown(NOW + 45e3, NOW)).toBe("45 dtk");
    expect(countdown(NOW + 12 * 60e3 + 5e3, NOW)).toBe("12:05");
    expect(countdown(NOW + 3 * 3600e3 + 12 * 60e3, NOW)).toBe("3j 12m");
    expect(countdown(NOW + 2 * 86400e3 + 5 * 3600e3, NOW)).toBe("2h 5j");
  });
  it("ago", () => {
    expect(ago(null, NOW)).toBe("belum pernah");
    expect(ago(NOW - 10e3, NOW)).toBe("baru saja");
    expect(ago(NOW - 5 * 60e3, NOW)).toBe("5 mnt lalu");
    expect(ago(NOW - 3 * 3600e3, NOW)).toBe("3 jam lalu");
    expect(ago(NOW - 2 * 86400e3, NOW)).toBe("2 hari lalu");
  });
  it("sort: running first, then soonest, none last", () => {
    const out = sortJobs([job({ id: "c", name: "c", nextRunAt: null }), job({ id: "b", name: "b", nextRunAt: NOW + 10 }), job({ id: "a", name: "a", running: true, nextRunAt: NOW + 99e3 })]);
    expect(out.map((j) => j.id)).toEqual(["a", "b", "c"]);
  });
  it("stale after CRON_STALE_MS or when the reporter stopped", () => {
    const c: CronState = { source: "x", controls: [], schedulerAlive: true, offline: false, jobs: [], receivedAt: NOW };
    expect(cronStale(c, NOW + CRON_STALE_MS - 1)).toBe(false);
    expect(cronStale(c, NOW + CRON_STALE_MS + 1)).toBe(true);
    expect(cronStale({ ...c, offline: true }, NOW)).toBe(true);
  });
  it("control URL only next to /api/stream", () => {
    expect(cronUrlFor("/api/stream", "http://localhost:8787/")).toBe("http://localhost:8787/api/cron");
    expect(cronUrlFor("http://127.0.0.1:9787/api/stream?x=1", "http://localhost/")).toBe("http://127.0.0.1:9787/api/cron");
    expect(cronUrlFor("/stream", "http://localhost/")).toBeNull();
    expect(cronUrlFor("ws://h/api/stream", "http://localhost/")).toBeNull();
    expect(cronUrlFor(null, "http://localhost/")).toBeNull();
  });
});

describe("events + store", () => {
  it("schedule and cron_command never become agents", () => {
    expect(normalizeEvent(RAW).map((e) => e.kind)).toEqual(["schedule"]);
    expect(normalizeEvent({ type: "cron_command", id: "c-1", action: "pause", job: "x", status: "queued" }).map((e) => e.kind)).toEqual(["cron_command"]);
    expect(normalizeEvent({ type: "cron_command", id: "c-1", action: "nope", status: "queued" })).toEqual([]);
  });
  it("store keeps the latest schedule, signals the engine, and clearAgents resets it", () => {
    const s = createHQStore();
    const signals: Signal[] = [];
    s.getState().onSignal((x) => signals.push(x));
    s.getState().applyEvent({ ...RAW, age_ms: 2000 });
    const st = s.getState();
    expect(st.agents.size).toBe(0);
    expect(st.cron?.jobs.map((j) => j.name)).toEqual(["Laporan harian", "Cek SSH"]);
    expect(Date.now() - st.cron!.receivedAt).toBeGreaterThanOrEqual(2000);
    expect(signals).toContainEqual({ type: "cron" });
    s.getState().clearAgents();
    expect(s.getState().cron).toBeNull();
  });
  it("commands: progress per id, log lines and a toast at the end", () => {
    const s = createHQStore();
    const cmd = { type: "cron_command", id: "c-1", action: "run", job: "a1b2c3d4e5f6", job_name: "Laporan harian" };
    s.getState().applyEvent({ ...cmd, status: "queued" });
    s.getState().applyEvent({ ...cmd, status: "sent" });
    s.getState().applyEvent({ ...cmd, status: "ok", message: "jalan di tick berikutnya" });
    const st = s.getState();
    expect(st.cronCmds).toHaveLength(1);
    expect(st.cronCmds[0]).toMatchObject({ id: "c-1", status: "ok", message: "jalan di tick berikutnya" });
    expect(st.logs.map((l) => [l.name, l.level, l.message])).toEqual([
      [CRON_LOG_ID, "info", "Perintah: Jalankan sekarang · Laporan harian"],
      [CRON_LOG_ID, "info", "Berhasil: Jalankan sekarang · Laporan harian · jalan di tick berikutnya"],
    ]);
    expect(st.toast?.msg).toBe("Berhasil: Jalankan sekarang · Laporan harian");
    expect(st.agents.size).toBe(0);
    s.getState().applyEvent({ ...cmd, id: "c-2", action: "pause", status: "error", message: "jadwal tidak ada di Hermes" });
    expect(s.getState().logs.at(-1)).toMatchObject({ level: "error", message: "Gagal: Jeda · Laporan harian · jadwal tidak ada di Hermes" });
  });
});
