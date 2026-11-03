// Scheduled-job controls (docs/hermes.md "Jadwal"). The schedule source (examples/hermes/hq_cron.py) posts
// {"type":"schedule"} snapshots to /api/event and long-polls /api/cron/commands; the office posts control commands
// to /api/cron. The bridge never runs anything itself: it only queues commands for the source, which checks them
// again and runs `hermes cron <action> <id>` as the Hermes user.

import { randomUUID } from "node:crypto";
import { CRON_ACTIONS, CRON_STALE_MS, type CronAction } from "../cron";
import { hub, publish, type BridgeCmd, type BridgeEvent } from "./hub";
import { redact, trunc } from "./redact";

/** A queued or sent command without an answer for this long fails. */
export const CMD_TIMEOUT_MS = 90_000;
const MAX_CMDS = 30;
const MAX_WAIT_MS = 25_000;
const JOB_ID = /^[\w.-]{1,64}$/;

type Reply = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string): Reply => ({ status, body: { ok: false, error } });

/** The stored schedule for a new viewer, with how old it is so the office can tell a stale one. */
export function scheduleForViewer(now = Date.now()): BridgeEvent | null {
  const c = hub.cron;
  return c.schedule ? { ...c.schedule, age_ms: Math.max(0, now - c.scheduleAt) } : null;
}

/**
 * True for a browser request made by another site (CSRF). Browsers send Sec-Fetch-Site and Origin; tools like curl
 * send neither and are allowed (they already run on the machine). Cross-origin JSON is also stopped by the missing
 * CORS headers on /api/cron, so this mainly blocks simple form posts.
 */
export function crossSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.get("origin");
  if (origin == null) return false;
  if (origin === "null") return true;
  try {
    return new URL(origin).host !== (req.headers.get("x-forwarded-host") || req.headers.get("host"));
  } catch {
    return true;
  }
}

const emit = (c: BridgeCmd) => publish({ type: "cron_command", ...c });
const open = (c: BridgeCmd) => c.status === "queued" || c.status === "sent";

/** Fail commands nobody answered, and keep only the newest MAX_CMDS. */
export function expireCommands(now = Date.now()): void {
  const cmds = hub.cron.cmds;
  for (const c of cmds.values()) {
    if (open(c) && now - c.at > CMD_TIMEOUT_MS) {
      c.status = "error";
      c.message = "Reporter jadwal tidak menjawab";
      emit(c);
    }
  }
  for (const id of [...cmds.keys()].slice(0, Math.max(0, cmds.size - MAX_CMDS))) cmds.delete(id);
}

/** POST /api/cron body {"action": "run" | "pause" | "resume", "job": "<id>"}. */
export function enqueueCommand(body: unknown, now = Date.now()): Reply {
  expireCommands(now);
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const action = b.action as CronAction;
  const job = typeof b.job === "string" ? b.job : "";
  if (!CRON_ACTIONS.includes(action)) return fail(400, "action harus run, pause, atau resume");
  if (!JOB_ID.test(job)) return fail(400, "job tidak valid");
  const sch = hub.cron.schedule;
  if (!sch) return fail(409, "Belum ada jadwal dari reporter");
  if (sch.offline === true || now - hub.cron.scheduleAt > CRON_STALE_MS) return fail(503, "Reporter jadwal tidak tersambung");
  if (!(Array.isArray(sch.controls) ? sch.controls : []).includes(action)) return fail(403, "Reporter tidak mengizinkan aksi ini");
  const jobs = Array.isArray(sch.jobs) ? (sch.jobs as Record<string, unknown>[]) : [];
  const j = jobs.find((x) => x && x.id === job);
  if (!j) return fail(404, "Jadwal tidak ditemukan");
  if ([...hub.cron.cmds.values()].some((c) => c.job === job && open(c))) return fail(409, "Perintah sebelumnya untuk jadwal ini belum selesai");
  const cmd: BridgeCmd = {
    id: `c-${randomUUID().slice(0, 8)}`,
    action,
    job,
    job_name: String(j.name ?? job).slice(0, 60),
    status: "queued",
    message: "",
    at: now,
  };
  hub.cron.cmds.set(cmd.id, cmd);
  emit(cmd);
  for (const wake of [...hub.cron.waiters]) wake();
  return { status: 202, body: { ok: true, command: cmd } };
}

/** Hand queued commands to the reporter (they become "sent"). */
export function takeCommands(now = Date.now()): { id: string; action: string; job: string }[] {
  expireCommands(now);
  const out: { id: string; action: string; job: string }[] = [];
  for (const c of hub.cron.cmds.values()) {
    if (c.status !== "queued") continue;
    c.status = "sent";
    emit(c);
    out.push({ id: c.id, action: c.action, job: c.job });
  }
  return out;
}

/** Resolve when a command is queued, after `ms`, or when `signal` aborts (long poll). */
export function waitForCommands(ms: number, signal?: AbortSignal): Promise<void> {
  if ([...hub.cron.cmds.values()].some((c) => c.status === "queued") || ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      hub.cron.waiters.delete(done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.min(ms, MAX_WAIT_MS));
    hub.cron.waiters.add(done);
    signal?.addEventListener("abort", done);
  });
}

/** POST /api/cron/result body {"id", "ok": bool, "message"}. */
export function finishCommand(body: unknown): Reply {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const c = typeof b.id === "string" ? hub.cron.cmds.get(b.id) : undefined;
  if (!c) return fail(404, "Perintah tidak ditemukan");
  if (!open(c)) return fail(409, "Perintah sudah selesai");
  c.status = b.ok === true ? "ok" : "error";
  c.message = trunc(redact(b.message), 200);
  emit(c);
  return { status: 200, body: { ok: true } };
}
