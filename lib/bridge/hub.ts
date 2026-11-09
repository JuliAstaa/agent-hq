// Event hub (port of the state half of references/server.js), with restart snapshots on disk.
// Lives on globalThis so it survives `next dev` reloads and is shared by every route bundle.
// Plus agent renames (not in the prototype): identity overrides by id, see ./overrides.ts.
// Plus kicks (prd.md §7.10): a kicked agent's events are held back in publish() until it shows activity again.

import { normalizeServerStats, serverPoint, trimHistory, type ServerPoint } from "../server";
import { redact, trunc } from "./redact";
import { IDENTITY_FIELDS, loadOverrides, mergeOverride, namesFile, saveOverrides, type Identity, type Override } from "./overrides";
import { loadSnapshot, saveSnapshot, stateFile, type Kicked, type Removal } from "./persistence";
import { emptyMeetingState, planMeetings, type AgentMeeting, type MeetingState } from "../meeting";
import { normStatus } from "../events";
import { readDiscussion, type DiscussionSummary } from "../discussions";
import { canKick, KICK_TTL_MS, kickRefusal, wakesUp } from "../kick";

export type BridgeEvent = Record<string, unknown>;
export type Send = (ev: BridgeEvent) => void;

/** A schedule-panel command (./cron.ts) as the bridge tracks and broadcasts it. */
export interface BridgeCmd {
  id: string;
  action: string;
  job: string;
  job_name: string;
  status: "queued" | "sent" | "ok" | "error";
  message: string;
  at: number;
}

/** Scheduled jobs (docs/hermes.md "Jadwal"): latest snapshot from the schedule source and the command queue. */
export interface CronHub {
  schedule: BridgeEvent | null;
  /** Date.now() when `schedule` arrived. */
  scheduleAt: number;
  /** Insertion order = age; trimmed by ./cron.ts. */
  cmds: Map<string, BridgeCmd>;
  /** Long-polling reporters waiting for a command. */
  waiters: Set<() => void>;
}

const newCronHub = (): CronHub => ({ schedule: null, scheduleAt: 0, cmds: new Map(), waiters: new Set() });

/** Server monitor (./server-stats.ts, prd.md §7.8): latest sample, 30 minutes of history, and the sampling loop. */
export interface ServerHub {
  last: BridgeEvent | null;
  /** Date.now() when `last` was published. */
  lastAt: number;
  /** Samples of the last 30 minutes (including `last`), oldest first, for the panel charts of new viewers. */
  history: ServerPoint[];
  /** Pending sample while the loop runs; null = stopped. */
  timer: ReturnType<typeof setTimeout> | null;
  /** CPU times of the previous sample (busy share is the difference). */
  prev: { idle: number; total: number } | null;
}

const newServerHub = (): ServerHub => ({ last: null, lastAt: 0, history: [], timer: null, prev: null });

interface Hub {
  discussions: Map<number, DiscussionSummary>;
  meetingState: MeetingState;
  meetingSeats: Map<string, AgentMeeting>;
  meetingDeskless: Set<string>;
  meetingKnown: Set<string>;
  /** id -> last known agent state (snapshot for new viewers). */
  agents: Map<string, BridgeEvent>;
  /** Last 80 log / finding / alert events (replayed to new viewers). */
  recent: BridgeEvent[];
  /** id -> timestamp of the last event (auto-remove of silent subagents). */
  lastSeen: Map<string, number>;
  removeTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Removal deadlines survive restarts without giving completed sessions a new grace period. */
  removals: Map<string, Removal>;
  /** id -> kicked agent (prd.md §7.10): kick time and the record it had, restored when it comes back. */
  kicked: Map<string, Kicked>;
  persistenceFile: string | null;
  persistenceWarned: boolean;
  subs: Set<Send>;
  /** id -> pinned name/role/team (rename), persisted in `overridesFile`. */
  overrides: Map<string, Override>;
  overridesFile: string;
  /** id -> identity as last sent by the agent itself (fallback when an override is cleared). */
  sourceIdentity: Map<string, Identity>;
  cron: CronHub;
  server: ServerHub;
}

const g = globalThis as unknown as { __hq?: Hub };
function createHub(): Hub {
  const file = stateFile();
  const saved = loadSnapshot(file);
  return {
    discussions: new Map(), meetingState: emptyMeetingState(), meetingSeats: new Map(), meetingDeskless: new Set(), meetingKnown: new Set(),
    agents: new Map(saved?.agents.map((a) => [String(a.id), a])),
    recent: saved?.recent ?? [],
    lastSeen: new Map(saved?.lastSeen),
    removeTimers: new Map(),
    removals: new Map(saved?.removals),
    kicked: new Map(saved?.kicked),
    persistenceFile: file,
    persistenceWarned: false,
    subs: new Set(),
    overrides: loadOverrides(),
    overridesFile: namesFile(),
    sourceIdentity: new Map(saved?.sourceIdentity),
    cron: newCronHub(),
    server: newServerHub(),
  };
}
export const hub: Hub = (g.__hq ??= createHub());
// A hub kept on globalThis by an older bundle (next dev reload) may predate the rename fields.
if (!hub.overrides) {
  hub.overridesFile = namesFile();
  hub.overrides = loadOverrides(hub.overridesFile);
}
hub.sourceIdentity ??= new Map();
hub.cron ??= newCronHub();
hub.server ??= newServerHub();
hub.server.history ??= [];
hub.discussions ??= new Map();
hub.meetingState ??= emptyMeetingState();
hub.meetingSeats ??= new Map();
hub.meetingDeskless ??= new Set();
hub.meetingKnown ??= new Set();
hub.removals ??= new Map();
hub.kicked ??= new Map();
if (hub.persistenceFile === undefined) hub.persistenceFile = stateFile();

/** Synchronous, atomic checkpoint: even a forced process restart keeps the last accepted agent event. */
function persistHub(): void {
  if (!hub.persistenceFile) return;
  try {
    saveSnapshot(hub.persistenceFile, {
      version: 1,
      agents: [...hub.agents.values()],
      recent: hub.recent,
      lastSeen: [...hub.lastSeen],
      sourceIdentity: [...hub.sourceIdentity],
      removals: [...hub.removals],
      kicked: [...hub.kicked],
    });
    hub.persistenceWarned = false;
  } catch {
    // Storage failures must not break hooks or live updates. Retry on the next event.
    if (!hub.persistenceWarned) console.warn("[hq] snapshot agen gagal disimpan; periksa izin dan ruang disk HQ_STATE_FILE");
    hub.persistenceWarned = true;
  }
}

// parent and group (prd.md §7.9) are not in references/server.js; the parity test ignores them.
const AGENT_KEYS = ["name", "role", "status", "state", "task", "current_task", "progress", "tokens", "cost", "team", "parent", "group"];

export const idOf = (ev: BridgeEvent): string => String(ev.id ?? ev.agent_id ?? ev.agentId ?? ev.agent ?? ev.name ?? "agent");

export function remember(ev: BridgeEvent): void {
  const type = String(ev.type || "agent_update").toLowerCase();
  if (type === "meeting_state") {
    const d = readDiscussion(ev.discussion);
    if (d) hub.discussions.set(d.room, d);
    return;
  }
  // Scheduled jobs are not agents: keep the latest snapshot for new viewers; commands are tracked by ./cron.ts.
  if (type === "schedule") {
    hub.cron.schedule = ev;
    hub.cron.scheduleAt = Date.now();
    return;
  }
  if (type === "cron_command") return;
  // Server monitor samples are not agents either: keep the latest and the history for new viewers.
  if (type === "server_stats") {
    const now = Date.now();
    hub.server.last = ev;
    hub.server.lastAt = now;
    const point = serverPoint({ ...normalizeServerStats(ev).stats, receivedAt: now });
    hub.server.history = trimHistory([...hub.server.history, point], now);
    return;
  }
  const id = idOf(ev);
  hub.lastSeen.set(id, Date.now());
  if (type === "remove") {
    forget(id);
    return;
  }
  if (["log", "finding", "alert", "metric"].includes(type)) {
    if (type !== "metric") {
      hub.recent.push(ev);
      if (hub.recent.length > 80) hub.recent.shift();
    }
    if (ev.id == null && ev.agent_id == null && ev.agent == null) return; // event without an agent
    if (!hub.agents.has(id)) hub.agents.set(id, { id, ...(ev.name ? { name: ev.name } : {}) });
    return;
  }
  hub.agents.set(id, mergeAgent(hub.agents.get(id) || { id }, ev, type));
}

/** Drop an agent's state and any pending removal of it. */
function forget(id: string): void {
  hub.agents.delete(id);
  hub.lastSeen.delete(id);
  hub.sourceIdentity.delete(id);
  clearTimeout(hub.removeTimers.get(id));
  hub.removeTimers.delete(id);
  hub.removals.delete(id);
}

/** Ids of the agents that name `parent` as their delegating agent (prd.md §7.9). */
const childrenOf = (parent: string): string[] =>
  [...hub.agents.values()].filter((a) => a.parent != null && String(a.parent) === parent).map((a) => String(a.id));

/** `prev` with the agent fields of `ev` applied (an agent's snapshot record). */
function mergeAgent(prev: BridgeEvent, ev: BridgeEvent, type: string): BridgeEvent {
  const next: BridgeEvent = { ...prev };
  for (const k of AGENT_KEYS) if (ev[k] !== undefined) next[k] = ev[k];
  if (ev.tokens_delta !== undefined) next.tokens = (Number(next.tokens) || 0) + Number(ev.tokens_delta);
  if (type === "task_done") {
    next.status = ev.status || "idle";
    next.progress = 1;
  }
  return next;
}

export function broadcast(ev: BridgeEvent): void {
  for (const send of hub.subs) {
    try {
      send(ev);
    } catch {
      hub.subs.delete(send);
    }
  }
}

/** Event types whose name/role/team describe the agent itself (metric uses `name` for the metric). */
const IDENTITY_TYPES = new Set(["agent_update", "task_done"]);

/** Record what the agent says about itself, then pin any override on top (so hooks cannot overwrite a rename). */
function applyIdentity(ev: BridgeEvent): void {
  if (!IDENTITY_TYPES.has(String(ev.type || "agent_update").toLowerCase())) return;
  const id = idOf(ev);
  if (!ev._renamed) {
    const src = { ...(hub.sourceIdentity.get(id) || {}) };
    for (const f of IDENTITY_FIELDS) if (typeof ev[f] === "string" && ev[f]) src[f] = ev[f] as string;
    hub.sourceIdentity.set(id, src);
  }
  delete ev._renamed;
  const o = hub.overrides.get(id);
  if (o) for (const f of IDENTITY_FIELDS) if (o[f] !== undefined) ev[f] = o[f];
}

export function publish(ev: BridgeEvent): void {
  ev.ts = ev.ts || new Date().toISOString();
  if (kickGate(ev)) return;
  // Meeting group (prd.md §7.9): a free label from any source, so it is redacted and cut like a name.
  if (typeof ev.group === "string") ev.group = trunc(redact(ev.group), 40);
  applyIdentity(ev);
  remember(ev);
  syncMeetingPlan();
  // Live server metrics and schedule commands are unrelated to agent restart state.
  if (!["server_stats", "schedule", "cron_command", "meeting_state"].includes(String(ev.type || "").toLowerCase())) persistHub();
  broadcast(ev);
  // A session's subagents leave with it (a failed subagent may never have sent SubagentStop). A kick keeps them.
  if (String(ev.type || "").toLowerCase() === "remove" && ev.reason !== "kick") {
    for (const child of childrenOf(idOf(ev))) publish({ type: "remove", id: child });
  }
}

/* ---------------- kick (prd.md §7.10) ---------------- */

/** Event types that never describe an agent. */
const NOT_AGENT = new Set(["meeting_state", "schedule", "cron_command", "server_stats"]);
/** Event types that name an agent only when they carry an id. */
const LINKED = new Set(["log", "finding", "alert", "metric"]);
/** Fields a returning agent's event takes from its kept record when it does not send them itself. */
const RETURN_FIELDS = ["parent", "group", "tokens", "cost"];

/**
 * Events of kicked agents. Returns true to drop `ev`. Activity (lib/kick.ts) brings the agent back: its kept record
 * returns to the snapshot, and the event carries the identity, team and tokens viewers no longer have. A remove, or
 * a kick older than KICK_TTL_MS, ends the kick. Anything else only updates the kept record; a metric keeps its value
 * but loses the agent link (it would add the agent again).
 */
function kickGate(ev: BridgeEvent): boolean {
  if (!hub.kicked.size) return false;
  const type = String(ev.type || "agent_update").toLowerCase();
  if (NOT_AGENT.has(type) || (LINKED.has(type) && ev.id == null && ev.agent_id == null && ev.agent == null)) return false;
  const id = idOf(ev);
  const k = hub.kicked.get(id);
  if (!k) return false;
  if (type === "remove" || Date.now() - k.at > KICK_TTL_MS) {
    hub.kicked.delete(id);
    return false;
  }
  if (wakesUp(type, normStatus(ev.status ?? ev.state))) {
    hub.kicked.delete(id);
    hub.agents.set(id, { ...k.agent });
    if (k.source) {
      hub.sourceIdentity.set(id, { ...k.source });
      for (const f of IDENTITY_FIELDS) if (ev[f] === undefined && k.source[f] !== undefined) ev[f] = k.source[f];
    }
    for (const f of RETURN_FIELDS) if (ev[f] === undefined && k.agent[f] !== undefined) ev[f] = k.agent[f];
    return false;
  }
  if (type === "metric") {
    for (const f of ["id", "agent_id", "agentId", "agent"]) delete ev[f];
    return false;
  }
  if (type === "agent_update" || type === "task_done") k.agent = mergeAgent(k.agent, ev, type);
  return true;
}

/** Known to the bridge: in the office, or kicked and waiting to come back. */
export const agentKnown = (id: string): boolean => hub.agents.has(id) || hub.kicked.has(id);

/**
 * Handle {"type":"kick", "id"|"match"}. Only an idle or offline agent can be kicked (409 otherwise). Broadcasts
 * {"type":"remove", "reason":"kick"}, so viewers launch it from the Airlock, and keeps its record for its return.
 */
export function kickAgent(ev: BridgeEvent): { status: number; body: Record<string, unknown> } {
  const found = findAgent(ev.id, ev.match, "kick");
  if (!("id" in found)) return { status: found.status, body: { ok: false, error: found.error, ...(found.candidates ? { candidates: found.candidates } : {}) } };
  const id = found.id;
  const a = hub.agents.get(id)!;
  const status = normStatus(a.status ?? a.state) ?? "idle";
  const name = identityOf(id).name;
  if (!canKick(status)) return { status: 409, body: { ok: false, id, status, error: kickRefusal(name, status) } };
  const kept: Kicked = { at: Date.now(), agent: { ...a }, source: hub.sourceIdentity.get(id) ?? null };
  publish({ type: "remove", id, reason: "kick" });
  for (const [k, v] of hub.kicked) if (kept.at - v.at > KICK_TTL_MS) hub.kicked.delete(k);
  hub.kicked.set(id, kept);
  persistHub();
  return { status: 202, body: { ok: true, kicked: true, id, name, matchedBy: found.matchedBy } };
}

/** Mirror the client's pure planner so a manual meeting cannot claim an occupied automatic room. */
export function syncMeetingPlan(): void {
  const list = [...hub.agents.values()].map((a) => {
    const id = String(a.id);
    const fresh = !hub.meetingKnown.has(id) && !!a.parent;
    if (fresh) hub.meetingDeskless.add(id);
    return { id, name: String(a.name || id), status: normStatus(a.status ?? a.state) ?? "idle", parent: a.parent ? String(a.parent) : null,
      group: a.group ? String(a.group) : null, dept: null, hasDesk: !hub.meetingDeskless.has(id), seat: hub.meetingSeats.get(id) ?? null };
  });
  const p = planMeetings(list, hub.meetingState, Date.now(), [...hub.discussions.values()]);
  hub.meetingState = { rooms: p.rooms, full: p.full };
  hub.meetingSeats = p.seats;
  hub.meetingKnown = new Set(list.map((a) => a.id));
  for (const id of hub.meetingDeskless) if (!p.seats.has(id)) hub.meetingDeskless.delete(id);
}

/* ---------------- rename ---------------- */

export interface AgentRow {
  id: string;
  name: string;
  role: string | null;
  team: string | null;
  status: string | null;
  renamed: boolean;
}

const identityOf = (id: string) => {
  const a = hub.agents.get(id) || {};
  return {
    name: String(a.name ?? id),
    role: a.role == null ? null : String(a.role),
    team: a.team == null ? null : String(a.team),
  };
};

/** GET /api/agents: every known agent, to look up a name or id before renaming. */
export function listAgents(): AgentRow[] {
  return [...hub.agents.values()].map((a) => {
    const id = String(a.id);
    return { id, ...identityOf(id), status: a.status == null ? (a.state == null ? null : String(a.state)) : String(a.status), renamed: hub.overrides.has(id) };
  });
}

type Found = { id: string; matchedBy: "id" | "name" | "prefix" } | { status: number; error: string; candidates?: string[] };

const notFound = (what: string): Found => ({
  status: 404,
  error: `Agen ${what} tidak ditemukan. Cek daftar agen dengan GET /agents (atau /api/agents).`,
});

/**
 * Find the agent a rename targets: `id` must match exactly; `match` tries, in order, an exact id, the displayed
 * name (case-insensitive), then an id or session prefix ("ab12" matches "cc-ab12cd34"). A prefix shared by a
 * session and its subagents resolves to the main session; any other tie is ambiguous (409).
 */
export function findAgent(id: unknown, match: unknown, what = "rename"): Found {
  if (id != null && id !== "") {
    const s = String(id);
    return hub.agents.has(s) ? { id: s, matchedBy: "id" } : notFound(`dengan id "${s}"`);
  }
  const m = typeof match === "string" || typeof match === "number" ? String(match).trim() : "";
  if (!m) return { status: 400, error: `${what} butuh "id" atau "match"` };
  if (hub.agents.has(m)) return { id: m, matchedBy: "id" };
  const ids = [...hub.agents.keys()];
  const lower = m.toLowerCase();
  const byName = ids.filter((i) => identityOf(i).name.toLowerCase() === lower);
  if (byName.length === 1) return { id: byName[0], matchedBy: "name" };
  if (byName.length > 1) return { status: 409, error: `Nama "${m}" dipakai ${byName.length} agen, pakai id.`, candidates: byName };
  const bare = lower.replace(/^cc-/, "");
  const byPrefix = ids.filter((i) => i.toLowerCase().startsWith(lower) || i.toLowerCase().replace(/^cc-/, "").startsWith(bare));
  if (byPrefix.length === 1) return { id: byPrefix[0], matchedBy: "prefix" };
  const main = byPrefix.filter((i) => /^cc-[^-]+$/.test(i));
  if (main.length === 1) return { id: main[0], matchedBy: "prefix" };
  if (byPrefix.length > 1) return { status: 409, error: `"${m}" cocok dengan ${byPrefix.length} agen, pakai id.`, candidates: byPrefix };
  return notFound(`"${m}"`);
}

/**
 * Handle {"type":"rename", "id"|"match", "name"?, "team"?, "role"?}. Saves the override file, then broadcasts an
 * agent_update with the new identity. A cleared team is sent as "office" so the agent walks back to its desk.
 */
export function renameAgent(ev: BridgeEvent): { status: number; body: Record<string, unknown> } {
  const found = findAgent(ev.id, ev.match);
  if (!("id" in found)) return { status: found.status, body: { ok: false, error: found.error, ...(found.candidates ? { candidates: found.candidates } : {}) } };
  const id = found.id;
  const merged = mergeOverride(hub.overrides.get(id), ev);
  if ("error" in merged) return { status: 400, body: { ok: false, error: merged.error } };
  const before = identityOf(id);
  if (merged.next) hub.overrides.set(id, merged.next);
  else hub.overrides.delete(id);
  try {
    saveOverrides(hub.overrides, hub.overridesFile);
  } catch (e) {
    return { status: 500, body: { ok: false, error: `gagal menyimpan ${hub.overridesFile}: ${(e as Error).message}` } };
  }
  const src = hub.sourceIdentity.get(id) || {};
  const o = merged.next || {};
  const update: BridgeEvent = { type: "agent_update", id, _renamed: true };
  for (const f of IDENTITY_FIELDS) {
    const v = o[f] ?? (merged.cleared.includes(f) || f in ev ? src[f] : undefined);
    if (v !== undefined) update[f] = v;
  }
  if ("team" in ev && !o.team) update.team = "office"; // cleared team: back to the office desk
  if ("name" in ev && update.name === undefined) update.name = id;
  publish(update);
  return {
    status: 202,
    body: { ok: true, id, matchedBy: found.matchedBy, before, after: identityOf(id), override: merged.next, file: hub.overridesFile },
  };
}

/** Test helper: re-read the overrides file (optionally a different one). */
export function reloadOverrides(file = namesFile()): void {
  hub.overridesFile = file;
  hub.overrides = loadOverrides(file);
}

/** Publish `remove` for `id` after `ms`, unless the agent sent another event in the meantime. */
export function scheduleRemove(id: string, ms: number): void {
  clearTimeout(hub.removeTimers.get(id));
  const mark = Date.now();
  const removal = { mark, at: mark + ms };
  hub.removals.set(id, removal);
  armRemoval(id, removal);
  persistHub();
}

function armRemoval(id: string, { mark, at }: Removal): void {
  const timer = setTimeout(() => {
    hub.removeTimers.delete(id);
    hub.removals.delete(id);
    if ((hub.lastSeen.get(id) || 0) <= mark + 50) publish({ type: "remove", id });
    else persistHub();
  }, Math.max(0, at - Date.now()));
  timer.unref?.();
  hub.removeTimers.set(id, timer);
}

/** Test helper: forget everything. */
export function resetHub(): void {
  hub.discussions.clear(); hub.meetingState = emptyMeetingState(); hub.meetingSeats.clear(); hub.meetingDeskless.clear(); hub.meetingKnown.clear();
  for (const t of hub.removeTimers.values()) clearTimeout(t);
  hub.agents.clear();
  hub.recent.length = 0;
  hub.lastSeen.clear();
  hub.removeTimers.clear();
  hub.removals.clear();
  hub.kicked.clear();
  hub.subs.clear();
  hub.sourceIdentity.clear();
  for (const wake of hub.cron.waiters) wake();
  hub.cron = newCronHub();
  if (hub.server.timer) clearTimeout(hub.server.timer);
  hub.server = newServerHub();
}

// Restore timers once per process, never once per route bundle/HMR. Expired agents must not enter snapshots.
let expired = false;
for (const [id, k] of hub.kicked) {
  if (Date.now() - k.at <= KICK_TTL_MS) continue;
  hub.kicked.delete(id);
  expired = true;
}
for (const [id, removal] of hub.removals) {
  if (hub.removeTimers.has(id)) continue;
  if ((hub.lastSeen.get(id) || 0) > removal.mark + 50) {
    hub.removals.delete(id);
    expired = true;
  } else if (removal.at <= Date.now()) {
    const gone = [id];
    // Subagents leave with their session, as in publish().
    while (gone.length) {
      const g = gone.pop()!;
      gone.push(...childrenOf(g));
      forget(g);
    }
    expired = true;
  } else armRemoval(id, removal);
}
if (expired) persistHub();
