// Client state: the contract between React UI and the Three.js engine (prd.md §14).
// Port of the state half of applyEvent()/pushLog()/clearAgents() in references/agent-hq.html.
//
// React writes floorMode and selectedId. The engine reads them and writes back derived per-agent
// location text (setLocs, throttled by the engine). One-shot effects for the engine (avatar add/remove,
// confetti, squash, snapshot placement, alert flash, camera focus) go through signals, not state.

import { createStore, type StoreApi } from "zustand/vanilla";
import { CRON_ACTION_LABEL, type CronCmd, type CronState } from "./cron";
import { normalizeEvent, SEV, STATUS, type AgentPatch, type AttackNode, type Severity, type Status } from "./events";
import { checkServerAlarm, newServerAlarm, SERVER_LOG_ID, serverPoint, trimHistory, type ServerPoint, type ServerStats } from "./server";
import { inferDept, type Dept } from "./teams";
import { emptyMeetingState, MEETING_LOG_ID, planMeetings, sameMeeting, sameRooms, type AgentMeeting, type MeetingRoom } from "./meeting";
import { avatarColor } from "./palette";
import { truncate } from "./format";
import { wakesUp } from "./kick";
import type { DiscussionSummary } from "./discussions";
import type { FloorMode } from "./zones";

/** Area view (single-floor layout, deviation 29): "all" or an area. Kept under its old name. */
export type { FloorMode };
export type ConnMode = "demo" | "live" | "down";

export const DESK_SLOTS = 9; // 3 x 3 desks in the office (deviation 17; the prototype had 12)
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
  /** Desk index 0..8; null = no desk: a subagent seated in a meeting room, or roster only (no avatar). */
  slot: number | null;
  /** Delegating agent (prd.md §7.9). */
  parent: string | null;
  /** Shared work group (prd.md §7.9). */
  group: string | null;
  /** Meeting seat while the agent's team holds a meeting (prd.md §7.9); null = works as usual. */
  meeting: AgentMeeting | null;
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
  /** Kicked (prd.md §7.10): the engine walks the avatar to the Airlock and launches it (instead of `remove`). */
  | { type: "kick"; id: string }
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
  | { type: "cron" }
  /** A server monitor sample arrived (or was cleared): redraw the server room now. */
  | { type: "server" };

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
  /** Latest server monitor sample; null = none (the server room stays decor). */
  server: ServerStats | null;
  /** Server samples of the last 30 minutes, oldest first, for the Server panel charts (bridge history + live). */
  serverHistory: ServerPoint[];
  /** Meeting rooms A, B, C (prd.md §7.9): the team holding each, or null. */
  meetings: (MeetingRoom | null)[];
  discussions: DiscussionSummary[];

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
  meetings: (MeetingRoom | null)[];
  /** New subagents that wait for the meeting plan before they take a desk. */
  pendingDesk: Set<string>;
}

export function createHQStore(): HQStore {
  const listeners = new Set<(s: Signal) => void>();
  let pending: Signal[] = [];
  let logKey = 0;
  let toastSeq = 0;
  let serverAlarm = newServerAlarm();
  let meetingFull: string[] = [];
  /** Agents kicked out of the office (lib/kick.ts): their events are ignored until one shows activity again. */
  const kicked = new Set<string>();

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
        meetings: s.meetings,
        pendingDesk: new Set(),
      };
    };
    const commit = (d: Draft) =>
      set({ agents: d.agents, logs: d.logs, stats: d.stats, soc: d.soc, vuln: d.vuln, selectedId: d.selectedId, toast: d.toast, meetings: d.meetings });

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
        color: a && (a.slot != null || a.meeting) ? avatarColor(a.id) : "#fff6e3",
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

    const removeInto = (d: Draft, id: string, kick = false) => {
      if (!d.agents.has(id)) return;
      d.agents.delete(id);
      d.touched.delete(id);
      d.pendingDesk.delete(id);
      if (d.selectedId === id) d.selectedId = null;
      emit({ type: kick ? "kick" : "remove", id });
    };

    /**
     * Events of a kicked agent: activity brings it back (true = it is back), anything else is dropped (null).
     * The live bridge filters these already; this covers demo mode. A snapshot is the bridge's truth.
     */
    const kickGate = (p: AgentPatch): boolean | null => {
      if (!kicked.has(p.id)) return false;
      if (!p.snap && !wakesUp(p.type, p.status)) return null;
      kicked.delete(p.id);
      return !p.snap;
    };

    /**
     * Meeting rooms (prd.md §7.9): recompute teams, rooms and seats after every agent change. A new subagent takes a
     * desk only when it gets no seat. In a snapshot (quiet) members are placed at their seats right away.
     */
    const planInto = (d: Draft, quiet: boolean) => {
      const list = [...d.agents.values()].map((a) => ({
        id: a.id, name: a.name, status: a.status, parent: a.parent, group: a.group, dept: a.dept,
        hasDesk: a.slot != null, seat: a.meeting,
      }));
      const plan = planMeetings(list, { rooms: d.meetings, full: meetingFull }, Date.now(), get().discussions);
      meetingFull = plan.full;
      if (!sameRooms(plan.rooms, d.meetings)) d.meetings = plan.rooms;
      for (const msg of plan.logs) logInto(d, { id: MEETING_LOG_ID, level: "info", message: msg });
      for (const a0 of d.agents.values()) {
        const want = plan.seats.get(a0.id) ?? null;
        const isNew = d.pendingDesk.has(a0.id);
        // No seat and no desk: a new subagent, or a desk-less one whose team lost its room.
        const needsDesk = !want && a0.slot == null && (isNew || !!a0.meeting);
        if (sameMeeting(a0.meeting, want) && !needsDesk) continue;
        const a = touch(d, a0.id)!;
        const seated = !!want && !a.meeting;
        a.meeting = want;
        if (needsDesk) {
          a.slot = freeSlot(d);
          if (a.slot == null && isNew) logInto(d, { id: a.id, level: "warn", message: `Meja penuh (maks ${DESK_SLOTS}), agen hanya tampil di daftar` });
          else if (isNew && quiet) emit({ type: "place", id: a.id }); // snapshot: idle to a lounge spot, team to a station
        }
        if (seated && quiet && !isNew) emit({ type: "place", id: a.id });
      }
      d.pendingDesk.clear();
    };

    const applyAgent = (d: Draft, p: AgentPatch) => {
      const id = p.id;
      const isNew = !d.agents.has(id);
      if (isNew) {
        // A subagent waits for the meeting plan (planInto): a meeting seat, else a desk.
        const sub = !!p.parent;
        const slot = sub ? null : freeSlot(d);
        d.agents.set(id, {
          id, name: p.name || id, role: p.role || "Agen", status: "idle", task: "", tokens: 0, cost: null, progress: null,
          updatedAt: Date.now(), events: [], slot, parent: null, group: null, meeting: null, deptSticky: null, dept: null, loc: null,
        });
        d.touched.add(id);
        if (sub) d.pendingDesk.add(id);
        emit({ type: "add", id });
        if (slot == null && !sub) logInto(d, { id, level: "warn", message: `Meja penuh (maks ${DESK_SLOTS}), agen hanya tampil di daftar` });
      }
      const a = touch(d, id)!;
      if (p.name && p.type !== "alert" && p.type !== "finding") a.name = p.name;
      if (p.role) a.role = p.role;
      if (p.task !== undefined && p.type !== "log") a.task = p.task;
      if (p.team !== undefined) a.deptExplicit = p.team;
      if (p.parent !== undefined) a.parent = p.parent;
      if (p.group !== undefined) a.group = p.group;
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
      if (e.kind === "meeting_state") {
        set({ discussions: [...get().discussions.filter((d) => d.room !== e.discussion.room), e.discussion] });
        const d = draft();
        planInto(d, false);
        commit(d);
        return;
      }
      if (e.kind === "metric") {
        if (e.login) emit({ type: "metric", value: e.value });
        return;
      }
      if (e.kind === "schedule") {
        set({ cron: { ...e.cron, receivedAt: Date.now() - e.ageMs } });
        emit({ type: "cron" });
        return;
      }
      if (e.kind === "server_stats") {
        const now = Date.now();
        const server = { ...e.stats, receivedAt: now - e.ageMs };
        // The first sample of a connection brings the bridge's history: it replaces what this page had.
        const before = e.history ? e.history.map((h) => ({ at: now - h.ageMs, cpu: h.cpu, mem: h.mem, disk: h.disk })) : get().serverHistory;
        const serverHistory = trimHistory([...before.filter((p) => p.at < server.receivedAt), serverPoint(server)], server.receivedAt);
        const notes = checkServerAlarm(serverAlarm, server);
        if (notes.length) {
          const d = draft();
          for (const n of notes) logInto(d, { id: SERVER_LOG_ID, level: n.level, message: n.log });
          const toast = notes.find((n) => n.toast)?.toast;
          if (toast) toastInto(d, toast);
          commit(d);
        }
        set({ server, serverHistory });
        emit({ type: "server" });
        return;
      }
      const agentPatch = e.kind === "agent" || e.kind === "alert" || e.kind === "finding" ? e.agent : null;
      const back = agentPatch ? kickGate(agentPatch) : false;
      if (back === null) return;
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
        const kick = e.kicked && d.agents.has(e.id);
        if (kick) {
          logInto(d, { id: e.id, level: "info", message: "Dikeluarkan lewat Airlock" });
          kicked.add(e.id);
        } else kicked.delete(e.id);
        removeInto(d, e.id, kick);
      } else {
        applyAgent(d, e.agent);
      }
      if (back && agentPatch) logInto(d, { id: agentPatch.id, level: "info", message: "Kembali ke kantor" });
      planInto(d, e.kind === "agent" && e.agent.quiet);
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
      server: null,
      serverHistory: [],
      meetings: emptyMeetingState().rooms,
      discussions: [],

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
        set({ discussions: [] });
        kicked.clear();
        const d = draft();
        for (const id of [...d.agents.keys()]) removeInto(d, id);
        d.stats = { done: 0, errors: 0 };
        d.logs = [];
        d.vuln = { counts: emptyCounts(), list: [], nodes: [] };
        d.soc = { alerts: [], total: 0 };
        d.meetings = emptyMeetingState().rooms; // everyone left: no "Rapat selesai" lines for a reset
        meetingFull = [];
        commit(d);
        const hadCron = get().cron !== null, hadServer = get().server !== null;
        set({ cron: null, cronCmds: [], server: null, serverHistory: [] }); // a new connection sends its own schedule and samples (if any)
        serverAlarm = newServerAlarm();
        emit({ type: "reset" });
        if (hadCron) emit({ type: "cron" }); // hide the schedule board
        if (hadServer) emit({ type: "server" }); // the server room back to decor
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
