// In-memory event hub (port of the state half of references/server.js).
// Lives on globalThis so it survives `next dev` reloads and is shared by every route bundle.
// Plus agent renames (not in the prototype): identity overrides by id, see ./overrides.ts.

import { IDENTITY_FIELDS, loadOverrides, mergeOverride, namesFile, saveOverrides, type Identity, type Override } from "./overrides";

export type BridgeEvent = Record<string, unknown>;
export type Send = (ev: BridgeEvent) => void;

interface Hub {
  /** id -> last known agent state (snapshot for new viewers). */
  agents: Map<string, BridgeEvent>;
  /** Last 80 log / finding / alert events (replayed to new viewers). */
  recent: BridgeEvent[];
  /** id -> timestamp of the last event (auto-remove of silent subagents). */
  lastSeen: Map<string, number>;
  removeTimers: Map<string, ReturnType<typeof setTimeout>>;
  subs: Set<Send>;
  /** id -> pinned name/role/team (rename), persisted in `overridesFile`. */
  overrides: Map<string, Override>;
  overridesFile: string;
  /** id -> identity as last sent by the agent itself (fallback when an override is cleared). */
  sourceIdentity: Map<string, Identity>;
}

const g = globalThis as unknown as { __hq?: Hub };
export const hub: Hub = (g.__hq ??= {
  agents: new Map(),
  recent: [],
  lastSeen: new Map(),
  removeTimers: new Map(),
  subs: new Set(),
  overrides: loadOverrides(),
  overridesFile: namesFile(),
  sourceIdentity: new Map(),
});
// A hub kept on globalThis by an older bundle (next dev reload) may predate the rename fields.
if (!hub.overrides) {
  hub.overridesFile = namesFile();
  hub.overrides = loadOverrides(hub.overridesFile);
}
hub.sourceIdentity ??= new Map();

const AGENT_KEYS = ["name", "role", "status", "state", "task", "current_task", "progress", "tokens", "cost", "team"];

export const idOf = (ev: BridgeEvent): string => String(ev.id ?? ev.agent_id ?? ev.agentId ?? ev.agent ?? ev.name ?? "agent");

export function remember(ev: BridgeEvent): void {
  const type = String(ev.type || "agent_update").toLowerCase();
  const id = idOf(ev);
  hub.lastSeen.set(id, Date.now());
  if (type === "remove") {
    hub.agents.delete(id);
    hub.lastSeen.delete(id);
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
  const next: BridgeEvent = { ...(hub.agents.get(id) || { id }) };
  for (const k of AGENT_KEYS) if (ev[k] !== undefined) next[k] = ev[k];
  if (ev.tokens_delta !== undefined) next.tokens = (Number(next.tokens) || 0) + Number(ev.tokens_delta);
  if (type === "task_done") {
    next.status = ev.status || "idle";
    next.progress = 1;
  }
  hub.agents.set(id, next);
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
  applyIdentity(ev);
  remember(ev);
  broadcast(ev);
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
export function findAgent(id: unknown, match: unknown): Found {
  if (id != null && id !== "") {
    const s = String(id);
    return hub.agents.has(s) ? { id: s, matchedBy: "id" } : notFound(`dengan id "${s}"`);
  }
  const m = typeof match === "string" || typeof match === "number" ? String(match).trim() : "";
  if (!m) return { status: 400, error: 'rename butuh "id" atau "match"' };
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
  const timer = setTimeout(() => {
    hub.removeTimers.delete(id);
    if ((hub.lastSeen.get(id) || 0) <= mark + 50) publish({ type: "remove", id });
  }, ms);
  timer.unref?.();
  hub.removeTimers.set(id, timer);
}

/** Test helper: forget everything. */
export function resetHub(): void {
  for (const t of hub.removeTimers.values()) clearTimeout(t);
  hub.agents.clear();
  hub.recent.length = 0;
  hub.lastSeen.clear();
  hub.removeTimers.clear();
  hub.subs.clear();
  hub.sourceIdentity.clear();
}
