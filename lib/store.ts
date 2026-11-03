// Client state: the contract between React UI and the Three.js engine (prd.md §14).
// Port of the state half of applyEvent()/pushLog()/clearAgents() in references/agent-hq.html.
//
// React writes floorMode and selectedId. The engine reads them and writes back derived per-agent
// location text (setLocs, throttled by the engine). One-shot effects for the engine (avatar add/remove,
// confetti, squash, snapshot placement, alert flash, camera focus) go through signals, not state.

import { createStore, type StoreApi } from "zustand/vanilla";
import { CRON_ACTION_LABEL, type CronCmd, type CronState } from "./cron";
import { normalizeEvent, SEV, STATUS, type AgentPatch, type AttackNode, type Severity, type Status } from "./events";
import { inferDept, type Dept } from "./teams";
import { avatarColor } from "./palette";
import { truncate } from "./format";

export type FloorMode = "all" | "1" | "2" | "3";
export type ConnMode = "demo" | "live" | "down";

export const DESK_SLOTS = 9; // 3 x 3 desks on floor 2 (deviation 17; the prototype had 12)
export const MAX_LOG_LINES = 220;
export const MAX_AGENT_EVENTS = 60;
export const MAX_CRON_CMDS = 12;
/** Log/agent id used for schedule-panel lines (like "SOC" for alerts). */
export const CRON_LOG_ID = "Jadwal";

export interface AgentEvent {
  t: number;
  level: string;
  msg: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: Status;
  task: string;
  tokens: number;
  cost: number | null;
  progress: number | null;
  updatedAt: number;
  events: AgentEvent[];
  /** Desk index 0..11; null = desks full, roster only (no avatar). */
  slot: number | null;
  /** undefined = no explicit team ever; null = explicitly office. */
  deptExplicit?: Dept | null;
  deptSticky: Dept | null;
  dept: Dept | null;
  /** Written by the engine: location chip text and current activity. */
  loc: { where: string; what: string } | null;
}

export interface LogLine {
  key: number;
  t: number;
  id: string;
  name: string;
  color: string;
  level: string;
  message: string;
}

export interface SocAlert {
  t: number;
  sev: Severity;
  text: string;
  ip: string;
}

export interface Finding {
  t: number;
  sev: Severity;
  title: string;
}

export type Signal =
  | { type: "add"; id: string }
  | { type: "remove"; id: string }
  | { type: "squash"; id: string }
  | { type: "confetti"; id: string }
  | { type: "place"; id: string }
  | { type: "alert"; text: string; ip: string; sev: Severity }
  | { type: "metric"; value: number }
  | { type: "finding" }
  | { type: "reset" }
  | { type: "floor"; floor: FloorMode; moveCam: boolean }
  | { type: "focus"; id: string }
  /** The schedule changed: redraw the schedule board now. */
  | { type: "cron" };

export interface HQState {
  /** Insertion order = roster order. */
  agents: Map<string, Agent>;
  logs: LogLine[];
  stats: { done: number; errors: number };
  soc: { alerts: SocAlert[]; total: number };
  vuln: { counts: Record<Severity, number>; list: Finding[]; nodes: AttackNode[] };
  floorMode: FloorMode;
  selectedId: string | null;
  conn: { mode: ConnMode; text: string };
  toast: { msg: string; seq: number } | null;
  /** Latest scheduled-jobs snapshot; null = no schedule source (board hidden). */
  cron: CronState | null;
  /** Recent schedule-panel commands, newest last. */
  cronCmds: CronCmd[];

  applyEvent: (raw: unknown) => void;
  pushLog: (entry: { id: string; level?: string; message?: string }) => void;
  clearAgents: () => void;
  setFloor: (floor: FloorMode, moveCam?: boolean) => void;
  select: (id: string | null, focus?: boolean) => void;
  setConn: (mode: ConnMode, text?: string) => void;
  showToast: (msg: string) => void;
  setLocs: (locs: Map<string, { where: string; what: string }>) => void;
  onSignal: (fn: (s: Signal) => void) => () => void;
}

export type HQStore = StoreApi<HQState>;

const emptyCounts = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

/** Working copy of the state for one event; committed with a single set(). */
interface Draft {
  agents: Map<string, Agent>;
  touched: Set<string>;
  logs: LogLine[];
  stats: { done: number; errors: number };
  soc: { alerts: SocAlert[]; total: number };
  vuln: { counts: Record<Severity, number>; list: Finding[]; nodes: AttackNode[] };
  selectedId: string | null;
  toast: HQState["toast"];
}

export function createHQStore(): HQStore {
  const listeners = new Set<(s: Signal) => void>();
  let pending: Signal[] = [];
  let logKey = 0;
  let toastSeq = 0;

  const emit = (s: Signal) => pending.push(s);
  const flush = () => {
    while (pending.length) {
      const batch = pending;
      pending = [];
      for (const s of batch) for (const fn of [...listeners]) fn(s);
    }
  };

  return createStore<HQState>()((set, get) => {
    const draft = (): Draft => {
      const s = get();
      return {
        agents: new Map(s.agents),
        touched: new Set(),
        logs: s.logs.slice(),
        stats: { ...s.stats },
        soc: { alerts: s.soc.alerts.slice(), total: s.soc.total },
        vuln: { counts: { ...s.vuln.counts }, list: s.vuln.list.slice(), nodes: s.vuln.nodes.slice() },
        selectedId: s.selectedId,
        toast: s.toast,
      };
    };
    const commit = (d: Draft) =>
      set({ agents: d.agents, logs: d.logs, stats: d.stats, soc: d.soc, vuln: d.vuln, selectedId: d.selectedId, toast: d.toast });

    /** Mutable clone of agent `id` inside the draft (cloned once per draft). */
    const touch = (d: Draft, id: string): Agent | undefined => {
      const a = d.agents.get(id);
      if (!a) return undefined;
      if (d.touched.has(id)) return a;
      const c = { ...a, events: a.events.slice() };
      d.agents.set(id, c);
      d.touched.add(id);
      return c;
    };

    const addAgentEvent = (a: Agent, level: string, msg: string) => {
      a.events.push({ t: Date.now(), level, msg });
      if (a.events.length > MAX_AGENT_EVENTS) a.events.shift();
    };

    const logInto = (d: Draft, { id, level = "info", message = "" }: { id: string; level?: string; message?: string }) => {
      const a = touch(d, id);
      if (a && level !== "move") addAgentEvent(a, level, message);
      d.logs.push({
        key: ++logKey,
        t: Date.now(),
        id,
        name: a?.name || id,
        color: a && a.slot != null ? avatarColor(a.id) : "#fff6e3",
        level,
        message,
      });
      while (d.logs.length > MAX_LOG_LINES) d.logs.shift();
    };

    const toastInto = (d: Draft, msg: string) => {
      d.toast = { msg, seq: ++toastSeq };
    };

    const freeSlot = (d: Draft): number | null => {
      const used = new Set<number>();
      for (const a of d.agents.values()) if (a.slot != null) used.add(a.slot);
      for (let i = 0; i < DESK_SLOTS; i++) if (!used.has(i)) return i;
      return null;
    };

    const removeInto = (d: Draft, id: string) => {
      if (!d.agents.has(id)) return;
      d.agents.delete(id);
      d.touched.delete(id);
      if (d.selectedId === id) d.selectedId = null;
      emit({ type: "remove", id });
    };

    const applyAgent = (d: Draft, p: AgentPatch) => {
      const id = p.id;
      const isNew = !d.agents.has(id);
      if (isNew) {
        const slot = freeSlot(d);
        d.agents.set(id, {
          id, name: p.name || id, role: p.role || "Agen", status: "idle", task: "", tokens: 0, cost: null, progress: null,
          updatedAt: Date.now(), events: [], slot, deptSticky: null, dept: null, loc: null,
        });
        d.touched.add(id);
        emit({ type: "add", id });
        if (slot == null) logInto(d, { id, level: "warn", message: `Meja penuh (maks ${DESK_SLOTS}), agen hanya tampil di daftar` });
      }
      const a = touch(d, id)!;
      if (p.name && p.type !== "alert" && p.type !== "finding") a.name = p.name;
      if (p.role) a.role = p.role;
      if (p.task !== undefined && p.type !== "log") a.task = p.task;
      if (p.team !== undefined) a.deptExplicit = p.team;
      ({ dept: a.dept, sticky: a.deptSticky } = inferDept(a));
      if (p.tokens !== undefined) a.tokens = p.tokens;
      if (p.tokensDelta !== undefined) a.tokens += p.tokensDelta;
      if (p.cost !== undefined) a.cost = p.cost;
      if (p.progress !== undefined) a.progress = p.progress;
      a.updatedAt = p.updatedAt;

      let ns = p.status;
      if (p.type === "task_done") {
        ns = ns || "idle";
        d.stats.done++;
        emit({ type: "confetti", id });
        logInto(d, { id, level: "info", message: `Selesai: ${p.task ?? a.task ?? "tugas"}` });
        a.progress = 1;
      }
      if (p.statusDone && p.type !== "task_done") {
        d.stats.done++;
        emit({ type: "confetti", id });
      }
      if (p.type === "log") {
        const lvl = p.level || "info";
        if (lvl === "error" && a.status !== "error" && !p.statusFieldError) d.stats.errors++;
        logInto(d, { id, level: lvl, message: p.message ?? "" });
      }
      if (ns && ns !== a.status) {
        const prev = a.status;
        a.status = ns;
        if (ns === "error" && p.type !== "log") d.stats.errors++;
        if (!p.quiet && p.type !== "log") {
          logInto(d, {
            id,
            level: ns === "error" ? "error" : ns === "waiting" ? "warn" : "info",
            message: `${STATUS[prev].label} → ${STATUS[ns].label}${a.task ? " · " + a.task : ""}`,
          });
        }
        emit({ type: "squash", id });
      } else if (p.task !== undefined && p.type === "agent_update" && !p.quiet && a.task) {
        addAgentEvent(a, "info", a.task);
      }
      if (a.status === "idle" || a.status === "offline") {
        a.deptSticky = null;
        a.dept = a.deptExplicit !== undefined ? a.deptExplicit : inferDept({ role: a.role }).dept;
      }
      // Snapshot: idle agents go straight to a lounge spot, team agents straight to a station.
      if ((isNew || p.snap) && a.slot != null && p.quiet) emit({ type: "place", id });
    };

    const applyOne = (e: ReturnType<typeof normalizeEvent>[number]) => {
      if (e.kind === "metric") {
        if (e.login) emit({ type: "metric", value: e.value });
        return;
      }
      if (e.kind === "schedule") {
        set({ cron: { ...e.cron, receivedAt: Date.now() - e.ageMs } });
        emit({ type: "cron" });
        return;
      }
      const d = draft();
      if (e.kind === "cron_command") {
        const c = e.cmd;
        const cmds = get().cronCmds.filter((x) => x.id !== c.id);
        cmds.push(c);
        set({ cronCmds: cmds.slice(-MAX_CRON_CMDS) });
        const what = `${CRON_ACTION_LABEL[c.action]} · ${c.jobName}`;
        if (c.status === "queued") logInto(d, { id: CRON_LOG_ID, level: "info", message: `Perintah: ${what}` });
        else if (c.status === "ok") {
          logInto(d, { id: CRON_LOG_ID, level: "info", message: `Berhasil: ${what}${c.message ? " · " + c.message : ""}` });
          toastInto(d, `Berhasil: ${truncate(what, 60)}`);
        } else if (c.status === "error") {
          logInto(d, { id: CRON_LOG_ID, level: "error", message: `Gagal: ${what}${c.message ? " · " + c.message : ""}` });
          toastInto(d, `Gagal: ${truncate(what, 40)}${c.message ? " · " + truncate(c.message, 40) : ""}`);
        }
        commit(d);
        return;
      }
      if (e.kind === "alert") {
        d.soc.total++;
        d.soc.alerts.unshift({ t: Date.now(), sev: e.sev, text: e.text, ip: e.ip });
        d.soc.alerts.length = Math.min(d.soc.alerts.length, 6);
        if (!e.replay) {
          emit({ type: "alert", text: e.text, ip: e.ip, sev: e.sev });
          if (e.sev === "critical" || e.sev === "high") toastInto(d, `Alert SOC: ${truncate(e.text, 60)}`);
        }
        logInto(d, { id: e.agentId ?? "SOC", level: "alert", message: `ALERT ${SEV[e.sev].label}: ${e.text}${e.ip ? " · " + e.ip : ""}` });
        if (e.agent) applyAgent(d, e.agent);
      } else if (e.kind === "finding") {
        d.vuln.counts[e.sev]++;
        d.vuln.list.unshift({ t: Date.now(), sev: e.sev, title: e.title });
        d.vuln.list.length = Math.min(d.vuln.list.length, 5);
        if (!d.vuln.nodes.includes(e.node)) d.vuln.nodes.push(e.node);
        logInto(d, { id: e.agentId ?? "VA", level: "find", message: `Temuan ${SEV[e.sev].label}: ${e.title}` });
        emit({ type: "finding" });
        if (e.agent) applyAgent(d, e.agent);
      } else if (e.kind === "remove") {
        removeInto(d, e.id);
      } else {
        applyAgent(d, e.agent);
      }
      commit(d);
    };

    return {
      agents: new Map(),
      logs: [],
      stats: { done: 0, errors: 0 },
      soc: { alerts: [], total: 0 },
      vuln: { counts: emptyCounts(), list: [], nodes: [] },
      floorMode: "all",
      selectedId: null,
      conn: { mode: "demo", text: "Mode demo" },
      toast: null,
      cron: null,
      cronCmds: [],

      applyEvent: (raw) => {
        for (const e of normalizeEvent(raw)) {
          applyOne(e);
          flush();
        }
      },

      pushLog: (entry) => {
        const d = draft();
        logInto(d, entry);
        commit(d);
      },

      clearAgents: () => {
        const d = draft();
        for (const id of [...d.agents.keys()]) removeInto(d, id);
        d.stats = { done: 0, errors: 0 };
        d.logs = [];
        d.vuln = { counts: emptyCounts(), list: [], nodes: [] };
        d.soc = { alerts: [], total: 0 };
        commit(d);
        const hadCron = get().cron !== null;
        set({ cron: null, cronCmds: [] }); // a new connection sends its own schedule (if any)
        emit({ type: "reset" });
        if (hadCron) emit({ type: "cron" }); // hide the schedule board
        flush();
      },

      setFloor: (floor, moveCam = true) => {
        set({ floorMode: floor });
        emit({ type: "floor", floor, moveCam });
        flush();
      },

      select: (id, focus = false) => {
        set({ selectedId: id });
        if (focus && id && get().agents.has(id)) emit({ type: "focus", id });
        flush();
      },

      setConn: (mode, text) => {
        set({ conn: { mode, text: text || (mode === "live" ? "Live" : mode === "down" ? "Terputus" : "Mode demo") } });
      },

      showToast: (msg) => set({ toast: { msg, seq: ++toastSeq } }),

      setLocs: (locs) => {
        const cur = get().agents;
        let next: Map<string, Agent> | null = null;
        for (const [id, loc] of locs) {
          const a = (next ?? cur).get(id);
          if (!a || (a.loc && a.loc.where === loc.where && a.loc.what === loc.what)) continue;
          next ??= new Map(cur);
          next.set(id, { ...a, loc });
        }
        if (next) set({ agents: next });
      },

      onSignal: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  });
}

/** App-wide store instance (browser). Tests create their own with createHQStore(). */
export const hqStore: HQStore = createHQStore();
