// In-memory event hub (port of the state half of references/server.js).
// Lives on globalThis so it survives `next dev` reloads and is shared by every route bundle.

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
}

const g = globalThis as unknown as { __hq?: Hub };
export const hub: Hub = (g.__hq ??= {
  agents: new Map(),
  recent: [],
  lastSeen: new Map(),
  removeTimers: new Map(),
  subs: new Set(),
});

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

export function publish(ev: BridgeEvent): void {
  ev.ts = ev.ts || new Date().toISOString();
  remember(ev);
  broadcast(ev);
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
}
