// Agent HQ event protocol v1 (prd.md §7): types and normalization.
// Pure functions, shared by the client store and the bridge tests. Ported from applyEvent() in
// references/agent-hq.html; the store applies the normalized result.

import { normalizeTeam, type Dept } from "./teams";

export type Status = "working" | "thinking" | "waiting" | "idle" | "error" | "offline";

export const STATUS: Record<Status, { label: string; color: string; icon: string }> = {
  working: { label: "Kerja", color: "#a6e22e", icon: "⚙" },
  thinking: { label: "Mikir", color: "#ffd23f", icon: "?" },
  waiting: { label: "Butuh kamu", color: "#ff9f1c", icon: "!" },
  idle: { label: "Santai", color: "#59c3ff", icon: "z" },
  error: { label: "Error", color: "#ff4f5e", icon: "✖" },
  offline: { label: "Offline", color: "#9a94b0", icon: "·" },
};

export const STATUS_KEYS = Object.keys(STATUS) as Status[];

export const STATUS_ALIAS: Record<string, Status> = {
  running: "working", busy: "working", active: "working", executing: "working", tool_call: "working", coding: "working",
  planning: "thinking", reasoning: "thinking", analyzing: "thinking",
  blocked: "waiting", needs_input: "waiting", human: "waiting", awaiting_input: "waiting", approval: "waiting", paused: "waiting",
  done: "idle", completed: "idle", finished: "idle", success: "idle", sleeping: "idle", ready: "idle",
  failed: "error", failure: "error", crashed: "error",
  stopped: "offline", dead: "offline", disconnected: "offline",
};

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Status string -> canonical status. Empty -> null. Unknown non-empty -> 'working'. */
export function normStatus(s: unknown): Status | null {
  if (!s) return null;
  const k = String(s).toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (has(STATUS, k)) return k as Status;
  return has(STATUS_ALIAS, k) ? STATUS_ALIAS[k] : "working";
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEV: Record<Severity, { label: string; color: string }> = {
  critical: { label: "Critical", color: "#c2185b" },
  high: { label: "High", color: "#ff4f5e" },
  medium: { label: "Medium", color: "#ff9f1c" },
  low: { label: "Low", color: "#ffd23f" },
  info: { label: "Info", color: "#59c3ff" },
};

export const SEV_KEYS = Object.keys(SEV) as Severity[];

export type AttackNode = "WEB" | "API" | "SSH" | "DB" | "ADMIN";

/** Attack-map node marked by a finding title (prd.md §7.3). */
export function findingNode(title: string): AttackNode {
  return /ssh/i.test(title) ? "SSH"
    : /\bdb\b|database|mysql|postgres|redis/i.test(title) ? "DB"
    : /api|idor/i.test(title) ? "API"
    : /admin|panel|wp-/i.test(title) ? "ADMIN"
    : "WEB";
}

export type RawEvent = Record<string, unknown>;

/** Per-agent part of an event, applied by the store to the agent with `id`. */
export interface AgentPatch {
  /** Lower-cased event type: agent_update, task_done, log, alert, finding, or anything else. */
  type: string;
  id: string;
  /** Raw `name` (truthy only). Names a new agent; renames an existing one unless type is alert/finding. */
  name?: string;
  role?: string;
  /** String(task) when task/current_task/activity/step is present. Not applied when type is 'log'. */
  task?: string;
  /** Present when team/room/dept is given. null = office (forces the home desk). */
  team?: Dept | null;
  tokens?: number;
  tokensDelta?: number;
  cost?: number;
  /** Clamped to 0..1 (values above 1 are treated as percent). */
  progress?: number;
  updatedAt: number;
  status: Status | null;
  /** Raw status was done/completed/finished/success (celebrates even without task_done). */
  statusDone: boolean;
  /** normStatus(ev.status) === 'error' (used to avoid double-counting error logs). */
  statusFieldError: boolean;
  /** type === 'log' only. */
  level?: string;
  message?: string;
  /** From snapshot: no transition log line, place idle agents in spots and team agents at stations. */
  quiet: boolean;
  snap: boolean;
}

export type HQEvent =
  | { kind: "metric"; name: string; value: number; login: boolean }
  | { kind: "alert"; agentId: string | null; sev: Severity; text: string; ip: string; replay: boolean; agent: AgentPatch | null }
  | { kind: "finding"; agentId: string | null; sev: Severity; title: string; node: AttackNode; agent: AgentPatch | null }
  | { kind: "remove"; id: string }
  | { kind: "agent"; agent: AgentPatch };

export function eventType(ev: RawEvent): string {
  return String(ev.type || ev.event || (ev.message && !ev.status ? "log" : "agent_update")).toLowerCase();
}

export function rawAgentId(ev: RawEvent): unknown {
  return ev.id ?? ev.agent_id ?? ev.agentId ?? ev.agent ?? ev.name;
}

export function alertSeverity(ev: RawEvent): Severity {
  const s = String(ev.severity || ev.level || "high").toLowerCase();
  return has(SEV, s) ? (s as Severity) : "high";
}

export function findingSeverity(ev: RawEvent): Severity {
  const raw = String(ev.severity || ev.level || "medium").toLowerCase();
  return has(SEV, raw) ? (raw as Severity) : raw === "moderate" ? "medium" : raw === "informational" ? "info" : "medium";
}

function agentPatch(ev: RawEvent, type: string, id: string, now: number): AgentPatch {
  const task = ev.task ?? ev.current_task ?? ev.activity ?? ev.step;
  const team = ev.team ?? ev.room ?? ev.dept;
  const p: AgentPatch = {
    type,
    id,
    updatedAt: ev.ts ? new Date(ev.ts as string | number).getTime() || now : now,
    status: normStatus(ev.status ?? ev.state),
    statusDone: ["done", "completed", "finished", "success"].includes(String(ev.status || "").toLowerCase()),
    statusFieldError: normStatus(ev.status) === "error",
    quiet: !!ev._quiet,
    snap: !!ev._snap,
  };
  if (ev.name) p.name = String(ev.name);
  if (ev.role) p.role = String(ev.role);
  if (task !== undefined) p.task = String(task);
  if (team !== undefined) p.team = normalizeTeam(team);
  if (ev.tokens !== undefined) p.tokens = Number(ev.tokens) || 0;
  if (ev.tokens_delta !== undefined) p.tokensDelta = Number(ev.tokens_delta) || 0;
  if (ev.cost !== undefined) p.cost = Number(ev.cost);
  if (ev.progress !== undefined && ev.progress !== null) {
    const n = Number(ev.progress);
    p.progress = Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
  }
  if (type === "log") {
    p.level = String(ev.level || "info").toLowerCase();
    p.message = String(ev.message ?? ev.text ?? "");
  }
  return p;
}

/**
 * Raw JSON (one event, an array, or a snapshot) -> ordered list of normalized events.
 * Non-objects are dropped. Snapshot entries become quiet agent updates.
 */
export function normalizeEvent(input: unknown, now = Date.now()): HQEvent[] {
  if (!input || typeof input !== "object") return [];
  if (Array.isArray(input)) return input.flatMap((x) => normalizeEvent(x, now));
  const ev = input as RawEvent;
  const type = eventType(ev);
  if (type === "snapshot") {
    const list = Array.isArray(ev.agents) ? ev.agents : [];
    return list.flatMap((x) => normalizeEvent({ ...(x as object), type: "agent_update", _quiet: true, _snap: true }, now));
  }
  const rawId = rawAgentId(ev);
  const id = String(rawId ?? "agent");
  const agentId = rawId == null ? null : id;
  if (type === "metric") {
    const name = String(ev.name || "failed_logins");
    return [{ kind: "metric", name, value: Number(ev.value) || 0, login: /fail|login|auth|brute/i.test(name) }];
  }
  if (type === "alert") {
    const ip = ev.source_ip ?? ev.ip ?? ev.src_ip ?? "";
    return [{
      kind: "alert",
      agentId,
      sev: alertSeverity(ev),
      text: String(ev.message ?? ev.title ?? ev.text ?? "Aktivitas mencurigakan"),
      ip: ip ? String(ip) : "",
      replay: !!ev._replay,
      agent: agentId == null ? null : agentPatch(ev, type, id, now),
    }];
  }
  if (type === "finding") {
    const title = String(ev.title ?? ev.message ?? ev.name ?? "Temuan baru");
    return [{
      kind: "finding",
      agentId,
      sev: findingSeverity(ev),
      title,
      node: findingNode(title),
      agent: agentId == null ? null : agentPatch(ev, type, id, now),
    }];
  }
  if (type === "remove") return [{ kind: "remove", id }];
  return [{ kind: "agent", agent: agentPatch(ev, type, id, now) }];
}
