// Meeting floor (prd.md §7.9): teams, the meeting rule, room and seat assignment.
// Pure functions shared by the store and the tests. No DOM, no three.js.

import type { Status } from "./events";
import type { Dept } from "./teams";
import { discussionActive, type DiscussionSummary } from "./discussions";

export const MEETING_ROOMS = ["Meeting A", "Meeting B", "Meeting C"] as const;
export const SEATS_PER_ROOM = 5;
/** Seat 0 is the head seat at the back of the table (the leader). */
export const HEAD_SEAT = 0;
/** Log name for meeting lines (like "SOC", "Jadwal", "Server"). */
export const MEETING_LOG_ID = "Meeting";
export const GROUP_MAX = 40;

export interface MeetingSeat {
  room: number;
  seat: number;
}

/** Seat of one agent, with the team's display name (roster: "rapat <team>"). */
export interface AgentMeeting extends MeetingSeat {
  team: string;
  /** Manual discussions receive their goal from the room monitor, rather than the task board. */
  discussionId?: string;
}

export interface MeetingRoom {
  /** Team key: "g:<group>" or "p:<leader id>". */
  key: string;
  name: string;
  leaderId: string | null;
  /** Accent color source: the leader's dept (or the head seat's in a group without a leader). */
  dept: Dept | null;
  /** Meeting start (epoch ms). */
  since: number;
}

export interface MeetingAgent {
  id: string;
  name: string;
  status: Status;
  parent: string | null;
  group: string | null;
  dept: Dept | null;
  hasDesk: boolean;
  /** Current seat (from the previous plan). */
  seat: MeetingSeat | null;
}

export interface MeetingState {
  rooms: (MeetingRoom | null)[];
  /** Teams already told "room full" during their current meeting. */
  full: string[];
}

export interface MeetingPlan extends MeetingState {
  seats: Map<string, AgentMeeting>;
  /** Log lines for MEETING_LOG_ID, in order. */
  logs: string[];
}

export const emptyMeetingState = (): MeetingState => ({ rooms: MEETING_ROOMS.map(() => null), full: [] });

/** `group` value -> trimmed label (max 40 chars), or null to clear. */
export function normalizeGroup(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim().slice(0, GROUP_MAX).trim();
  return s || null;
}

/** `parent` value -> id, or null to clear. An agent cannot be its own parent. */
export function normalizeParent(v: unknown, id: string): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s && s !== id ? s : null;
}

const ACTIVE: Status[] = ["working", "thinking", "waiting", "error"];
export const isActive = (s: Status) => ACTIVE.includes(s);

const groupKey = (g: string) => "g:" + g.toLowerCase();

/** Minutes for "Rapat selesai: <team> (<n> mnt)", at least 1. */
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60000));

/**
 * Team per agent. Key: the agent's own group; else, for a subagent, its top parent's group, else that parent's id;
 * else, for an agent another agent names as parent, its own id. Agents without a team are left out.
 */
export function teamsOf(agents: MeetingAgent[]) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const parentOf = (a: MeetingAgent) => (a.parent && a.parent !== a.id ? a.parent : null);
  const named = new Set<string>();
  for (const a of agents) {
    const p = parentOf(a);
    if (p) named.add(p);
  }
  /** Top of the parent chain (nested delegation), cycle-safe. */
  const rootOf = (a: MeetingAgent): string | null => {
    let r = parentOf(a);
    const seen = new Set([a.id]);
    while (r && !seen.has(r)) {
      seen.add(r);
      const up = byId.get(r);
      const next = up && parentOf(up);
      if (!next || seen.has(next)) break;
      r = next;
    }
    return r;
  };
  const key = new Map<string, string>();
  const root = new Map<string, string>();
  for (const a of agents) {
    const r = rootOf(a);
    if (r) root.set(a.id, r);
    const rg = r ? byId.get(r)?.group : null;
    const k = a.group ? groupKey(a.group) : rg ? groupKey(rg) : r ? "p:" + r : named.has(a.id) ? "p:" + a.id : null;
    if (k) key.set(a.id, k);
  }
  return { byId, key, root, named, isSub: (a: MeetingAgent) => !!parentOf(a) };
}

/**
 * The meeting rule and room/seat assignment (prd.md §7.9). `agents` in roster order (it decides which team gets a
 * room first and who sits first). Returns the seats, the new room list, and the log lines to write.
 */
export function planMeetings(agents: MeetingAgent[], prev: MeetingState, now: number, discussions: DiscussionSummary[] = []): MeetingPlan {
  const { byId, key, root, named, isSub } = teamsOf(agents);
  const manual = discussions.filter((d) => discussionActive(d.phase));
  const reserved = new Set(manual.flatMap((d) => d.participants.map((p) => p.agentId)));
  interface Team { key: string; members: MeetingAgent[]; attend: MeetingAgent[]; on: boolean; leaderId: string | null; name: string }
  const teams = new Map<string, Team>();
  for (const a of agents) {
    if (reserved.has(a.id)) continue;
    const k = key.get(a.id);
    if (!k) continue;
    let t = teams.get(k);
    if (!t) teams.set(k, (t = { key: k, members: [], attend: [], on: false, leaderId: null, name: "" }));
    t.members.push(a);
  }
  for (const t of teams.values()) {
    const subs = t.members.filter(isSub);
    // Leader: the parent at the top of the chain (p: teams), or the first member someone delegated from (groups).
    t.leaderId = t.key.startsWith("p:") ? t.key.slice(2) : (subs.map((s) => root.get(s.id)!).find((r) => byId.has(r)) ?? t.members.find((m) => named.has(m.id))?.id ?? null);
    const activeSubs = subs.filter((s) => isActive(s.status)).length;
    const activeAll = t.members.filter((m) => isActive(m.status)).length;
    t.on = activeSubs >= 1 || activeAll >= 2;
    const parentOfActive = new Set(subs.filter((s) => isActive(s.status)).map((s) => s.parent));
    t.attend = t.members.filter((m) => {
      // A subagent seated without a desk keeps its seat until it is removed, meeting or not.
      if (isSub(m) && !m.hasDesk) return true;
      if (!t.on || m.status === "offline") return false;
      return isSub(m) || m.id === t.leaderId || parentOfActive.has(m.id) || isActive(m.status);
    });
    const leader = t.leaderId ? byId.get(t.leaderId) : undefined;
    const g = t.key.startsWith("g:") ? (t.members.find((m) => m.group && groupKey(m.group) === t.key)?.group ?? null) : null;
    t.name = g ?? `Tim ${leader?.name ?? t.leaderId ?? t.members[0].name}`;
  }

  const logs: string[] = [];
  const rooms = prev.rooms.map((r) => r);
  while (rooms.length < MEETING_ROOMS.length) rooms.push(null);
  const full = new Set(prev.full.filter((k) => teams.get(k)?.on));
  // 1. Rooms stay with their team while it has someone at the table; otherwise the meeting is over.
  rooms.forEach((r, i) => {
    if (!r) return;
    if (r.key.startsWith("d:") && manual.some((d) => d.room === i && r.key === "d:" + d.id)) return;
    const t = teams.get(r.key);
    if (!t || !t.attend.length) {
      logs.push(`Rapat selesai: ${r.name} (${minutes(now - r.since)} mnt)`);
      rooms[i] = null;
    }
  });
  for (const d of manual) {
    if (rooms[d.room]?.key !== "d:" + d.id) logs.push(`Rapat mulai: Diskusi di ${MEETING_ROOMS[d.room]}`);
    rooms[d.room] = { key: "d:" + d.id, name: "Diskusi", leaderId: d.participants[0].agentId, dept: null, since: d.since };
  }
  // 2. Teams at the table without a room take the first free one, in roster order.
  for (const t of teams.values()) {
    if (!t.attend.length || rooms.some((r) => r?.key === t.key)) continue;
    const i = rooms.findIndex((r) => !r);
    if (i < 0) {
      if (t.on && !full.has(t.key)) {
        logs.push(`Ruang meeting penuh, ${t.name} kerja di meja`);
        full.add(t.key);
      }
      continue;
    }
    full.delete(t.key);
    rooms[i] = { key: t.key, name: t.name, leaderId: t.leaderId, dept: null, since: now };
    logs.push(`Rapat mulai: ${t.name} di ${MEETING_ROOMS[i]}`);
  }
  // 3. Seats: keep the ones people already have, the head seat for the leader, then fill up; the rest work as today.
  const seats = new Map<string, AgentMeeting>();
  rooms.forEach((r, room) => {
    if (!r) return;
    const d = manual.find((d) => d.room === room);
    if (d) {
      d.participants.forEach((p, seat) => { if (byId.has(p.agentId)) seats.set(p.agentId, { room, seat, team: "Diskusi", discussionId: d.id }); });
      return;
    }
    const t = teams.get(r.key)!;
    const taken: (string | null)[] = Array(SEATS_PER_ROOM).fill(null);
    const waiting: MeetingAgent[] = [];
    for (const m of t.attend) {
      const s = m.seat;
      if (s && s.room === room && s.seat >= 0 && s.seat < SEATS_PER_ROOM && !taken[s.seat]) taken[s.seat] = m.id;
      else waiting.push(m);
    }
    const leader = t.leaderId ? byId.get(t.leaderId) : undefined;
    // The head seat is the leader's. A group without a leader gives it to whoever sits first; otherwise it is the
    // last seat handed out, and never while the leader is in the office (it may still walk in).
    const leaderExpected = !!leader && leader.status !== "offline";
    for (const m of waiting) {
      let i = -1;
      if ((m.id === t.leaderId || !t.leaderId) && !taken[HEAD_SEAT]) i = HEAD_SEAT;
      for (let k = 1; k < SEATS_PER_ROOM && i < 0; k++) if (!taken[k]) i = k;
      if (i < 0 && !taken[HEAD_SEAT] && !leaderExpected) i = HEAD_SEAT;
      if (i >= 0) taken[i] = m.id;
    }
    taken.forEach((id, seat) => {
      if (id) seats.set(id, { room, seat, team: t.name });
    });
    const head = taken[HEAD_SEAT] ? byId.get(taken[HEAD_SEAT]!) : undefined;
    rooms[room] = { ...r, name: t.name, leaderId: t.leaderId, dept: (leader ?? head)?.dept ?? null };
  });
  return { rooms, full: [...full], seats, logs };
}

/** Same seat and team name? */
export const sameMeeting = (a: AgentMeeting | null | undefined, b: AgentMeeting | null | undefined) =>
  (!a && !b) || (!!a && !!b && a.room === b.room && a.seat === b.seat && a.team === b.team && a.discussionId === b.discussionId);

/** Same room list (for skipping store updates)? */
export const sameRooms = (a: (MeetingRoom | null)[], b: (MeetingRoom | null)[]) =>
  a.length === b.length &&
  a.every((r, i) => {
    const o = b[i];
    return (!r && !o) || (!!r && !!o && r.key === o.key && r.name === o.name && r.leaderId === o.leaderId && r.dept === o.dept && r.since === o.since);
  });
