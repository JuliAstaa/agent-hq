// Meeting floor (prd.md §7.9): fields, teams, the meeting rule, rooms and seats, the store, the bridge.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyMeetingState, normalizeGroup, normalizeParent, planMeetings, teamsOf, type MeetingAgent, type MeetingState } from "@/lib/meeting";
import { normalizeEvent } from "@/lib/events";
import { hookToEvents } from "@/lib/bridge/hooks";
import { hub, publish, resetHub, type BridgeEvent } from "@/lib/bridge/hub";
import { createHQStore, DESK_SLOTS, type HQStore, type Signal } from "@/lib/store";
import { createDemo } from "@/lib/demo";
import type { Status } from "@/lib/events";

const A = (id: string, status: Status, extra: Partial<MeetingAgent> = {}): MeetingAgent => ({
  id, name: id.toUpperCase(), status, parent: null, group: null, dept: null, hasDesk: true, seat: null, ...extra,
});
const sub = (id: string, parent: string, status: Status = "working", extra: Partial<MeetingAgent> = {}) => A(id, status, { parent, hasDesk: false, ...extra });

/** Run the plan the way the store does: feed seats back in, keep the state between calls. */
function planner() {
  let state: MeetingState = emptyMeetingState();
  let seats = new Map<string, { room: number; seat: number }>();
  let now = 1_000_000;
  return {
    plan(list: MeetingAgent[], dt = 1000) {
      now += dt;
      const p = planMeetings(list.map((a) => ({ ...a, seat: seats.get(a.id) ?? null })), state, now);
      state = { rooms: p.rooms, full: p.full };
      seats = new Map([...p.seats].map(([id, s]) => [id, { room: s.room, seat: s.seat }]));
      return p;
    },
  };
}

describe("fields (prd.md §7.9)", () => {
  it("group: trimmed, whitespace collapsed, max 40 chars, empty clears", () => {
    expect(normalizeGroup("  Rilis   v2.3 ")).toBe("Rilis v2.3");
    expect(normalizeGroup("x".repeat(60))).toHaveLength(40);
    expect(normalizeGroup("")).toBeNull();
    expect(normalizeGroup(null)).toBeNull();
  });
  it("parent: own id ignored, empty clears", () => {
    expect(normalizeParent("cc-ab12cd34", "cc-ab12cd-9f8e7d6c")).toBe("cc-ab12cd34");
    expect(normalizeParent("a", "a")).toBeNull();
    expect(normalizeParent("", "a")).toBeNull();
  });
  it("normalizeEvent carries parent and group only when given", () => {
    const [e] = normalizeEvent({ type: "agent_update", id: "s1", parent: "lead", group: " Rilis v2.3 " });
    expect(e).toMatchObject({ kind: "agent", agent: { parent: "lead", group: "Rilis v2.3" } });
    const [f] = normalizeEvent({ type: "agent_update", id: "s1", status: "working" });
    expect(f.kind === "agent" && "parent" in f.agent).toBe(false);
    const [g] = normalizeEvent({ type: "task_done", id: "s1", parent: null, group: "" });
    expect(g).toMatchObject({ agent: { parent: null, group: null } });
  });
});

describe("hook translation and the bridge", () => {
  const SID = "5f3c9a1e-7b2d-4c11-9e0f-0123456789ab";
  const run = (h: Record<string, unknown>, headers: Record<string, string> = {}) =>
    hookToEvents({ session_id: SID, cwd: "/srv/shop-api", ...h }, (n) => headers[n], vi.fn());

  it("every subagent event names the main session as parent; the main session has none", () => {
    for (const ev of run({ hook_event_name: "SubagentStart", agent_id: "agent-9f8e7d6c5b", agent_type: "Explore" })) expect(ev).toMatchObject({ parent: "cc-5f3c9a1e" });
    const stop = run({ hook_event_name: "SubagentStop", agent_id: "agent-9f8e7d6c5b", agent_type: "Explore" });
    expect(stop[0]).toMatchObject({ type: "task_done", parent: "cc-5f3c9a1e" });
    for (const ev of run({ hook_event_name: "UserPromptSubmit", prompt: "hi" })) expect(ev).not.toHaveProperty("parent");
  });
  it("X-HQ-Group adds the group (redacted, 40 chars); empty header adds nothing", () => {
    const [ev] = run({ hook_event_name: "SessionStart" }, { "x-hq-group": " Rilis v2.3 " });
    expect(ev).toMatchObject({ group: "Rilis v2.3" });
    const [red] = run({ hook_event_name: "SessionStart" }, { "x-hq-group": "token=sk-live-abcdef0123456789" });
    expect(red.group).toBe("token=***");
    const [none] = run({ hook_event_name: "SessionStart" }, { "x-hq-group": "" });
    expect(none).not.toHaveProperty("group");
  });
  it("publish redacts and cuts a posted group; the snapshot keeps parent and group", () => {
    resetHub();
    const sent: BridgeEvent[] = [];
    hub.subs.add((e) => sent.push(e));
    publish({ type: "agent_update", id: "meet-lead", group: "password=hunter2 " + "y".repeat(80), status: "working" });
    publish({ type: "agent_update", id: "meet-sub", parent: "meet-lead", status: "working" });
    expect(String(sent[0].group)).toMatch(/^password=\*\*\* y+…$/);
    expect(String(sent[0].group)).toHaveLength(40);
    expect(hub.agents.get("meet-sub")).toMatchObject({ parent: "meet-lead" });
    expect(hub.agents.get("meet-lead")).toMatchObject({ group: sent[0].group });
    resetHub();
  });
});

describe("teams", () => {
  it("subagents join their parent; nested delegation goes to the top; groups win", () => {
    const { key } = teamsOf([
      A("lead", "working"), sub("s1", "lead"), sub("s2", "s1"),
      A("x", "working", { group: "Rilis" }), A("y", "idle", { group: "rilis" }), sub("xs", "x"),
      A("solo", "working"),
    ]);
    expect(key.get("lead")).toBe("p:lead");
    expect(key.get("s1")).toBe("p:lead");
    expect(key.get("s2")).toBe("p:lead");
    expect(key.get("x")).toBe("g:rilis");
    expect(key.get("y")).toBe("g:rilis");
    expect(key.get("xs")).toBe("g:rilis"); // the parent's group
    expect(key.has("solo")).toBe(false);
  });
  it("a parent cycle does not hang", () => {
    const { key } = teamsOf([A("a", "working", { parent: "b" }), A("b", "working", { parent: "a" })]);
    expect(key.size).toBe(2);
  });
});

describe("meeting rule, rooms and seats", () => {
  it("one active subagent starts a meeting: the leader takes the head seat, the subagent a side seat", () => {
    const p = planner().plan([A("lead", "working"), sub("s1", "lead")]);
    expect(p.logs).toEqual(["Rapat mulai: Tim LEAD di Meeting A"]);
    expect(p.rooms[0]).toMatchObject({ key: "p:lead", name: "Tim LEAD", leaderId: "lead" });
    expect(p.seats.get("lead")).toEqual({ room: 0, seat: 0, team: "Tim LEAD" });
    expect(p.seats.get("s1")).toMatchObject({ room: 0, seat: 1 });
  });

  it("an idle leader waits at the table; a finished subagent keeps its seat until removed; then the room frees", () => {
    const pl = planner();
    pl.plan([A("lead", "working"), sub("s1", "lead")]);
    let p = pl.plan([A("lead", "idle"), sub("s1", "lead", "working")]);
    expect(p.seats.get("lead")).toMatchObject({ seat: 0 });
    p = pl.plan([A("lead", "idle"), sub("s1", "lead", "idle")]);
    expect(p.seats.has("lead")).toBe(false); // meeting over: the leader goes back to its day
    expect(p.seats.get("s1")).toMatchObject({ room: 0, seat: 1 }); // desk-less: stays until removed
    p = pl.plan([A("lead", "idle")], 120_000);
    expect(p.rooms[0]).toBeNull();
    expect(p.logs).toEqual(["Rapat selesai: Tim LEAD (2 mnt)"]);
  });

  it("an offline leader is not seated and its head seat is not taken", () => {
    const p = planner().plan([A("lead", "offline"), sub("s1", "lead"), sub("s2", "lead")]);
    expect(p.seats.has("lead")).toBe(false);
    expect([...p.seats.values()].map((s) => s.seat).sort()).toEqual([1, 2]);
  });

  it("a group meets while two members are active; idle members do not sit; the first to sit takes the head", () => {
    const pl = planner();
    let p = pl.plan([A("x", "working", { group: "Rilis v2.3" }), A("y", "idle", { group: "rilis v2.3" })]);
    expect(p.rooms.every((r) => !r)).toBe(true);
    p = pl.plan([A("x", "working", { group: "Rilis v2.3" }), A("y", "thinking", { group: "rilis v2.3" }), A("z", "idle", { group: "Rilis V2.3" })]);
    expect(p.rooms[0]).toMatchObject({ name: "Rilis v2.3", leaderId: null });
    expect(p.seats.get("x")).toMatchObject({ seat: 0 });
    expect(p.seats.get("y")).toMatchObject({ seat: 1 });
    expect(p.seats.has("z")).toBe(false);
  });

  it("rooms go in roster order; with all three taken the next team works as today, told once, and moves in later", () => {
    const pl = planner();
    const teams = (n: number) => Array.from({ length: n }, (_, i) => [A("l" + i, "working"), sub("s" + i, "l" + i)]).flat();
    let p = pl.plan(teams(4));
    expect(p.rooms.map((r) => r?.leaderId)).toEqual(["l0", "l1", "l2"]);
    expect(p.logs.at(-1)).toBe("Ruang meeting penuh, Tim L3 kerja di meja");
    expect(p.seats.has("l3")).toBe(false);
    p = pl.plan(teams(4));
    expect(p.logs).toEqual([]); // not told again
    p = pl.plan(teams(4).filter((a) => a.id !== "l1" && a.id !== "s1"));
    expect(p.logs).toEqual(["Rapat selesai: Tim L1 (1 mnt)", "Rapat mulai: Tim L3 di Meeting B"]);
    expect(p.seats.get("l3")).toMatchObject({ room: 1, seat: 0 });
    expect(p.seats.get("l0")).toMatchObject({ room: 0 }); // nobody else moves
  });

  it("five seats: extra members work as today", () => {
    const list = [A("lead", "working"), ...Array.from({ length: 6 }, (_, i) => sub("s" + i, "lead"))];
    const p = planner().plan(list);
    expect(p.seats.size).toBe(5);
    expect(p.seats.get("lead")).toMatchObject({ seat: 0 });
    expect(p.seats.has("s4")).toBe(false);
    expect(p.seats.has("s5")).toBe(false);
  });

  it("seats stay put when others come and go", () => {
    const pl = planner();
    pl.plan([A("lead", "working"), sub("s1", "lead"), sub("s2", "lead")]);
    const p = pl.plan([A("lead", "working"), sub("s2", "lead"), sub("s3", "lead")]);
    expect(p.seats.get("s2")).toMatchObject({ seat: 2 });
    expect(p.seats.get("s3")).toMatchObject({ seat: 1 });
  });

  it("the accent follows the leader's dept", () => {
    const p = planner().plan([A("lead", "working", { dept: "red" }), sub("s1", "lead")]);
    expect(p.rooms[0]?.dept).toBe("red");
  });
});

describe("store (prd.md §7.9)", () => {
  let store: HQStore;
  let signals: Signal[];
  const S = () => store.getState();
  const apply = (ev: unknown) => S().applyEvent(ev);
  const agent = (id: string) => S().agents.get(id)!;
  const meetingLogs = () => S().logs.filter((l) => l.id === "Meeting").map((l) => l.message);
  beforeEach(() => {
    store = createHQStore();
    signals = [];
    S().onSignal((s) => signals.push(s));
  });

  it("a delegating session and its subagent meet in Meeting A; the subagent takes no desk", () => {
    apply({ id: "lead", name: "Glimbo", status: "working", task: "Delegasi: cari bug" });
    apply({ id: "s1", name: "Explore", parent: "lead", status: "working" });
    expect(agent("lead")).toMatchObject({ slot: 0, meeting: { room: 0, seat: 0, team: "Tim Glimbo" } });
    expect(agent("s1")).toMatchObject({ slot: null, parent: "lead", meeting: { room: 0, seat: 1 } });
    expect(S().meetings[0]).toMatchObject({ name: "Tim Glimbo", leaderId: "lead" });
    expect(meetingLogs()).toEqual(["Rapat mulai: Tim Glimbo di Meeting A"]);
    expect(signals).toContainEqual({ type: "add", id: "s1" });
    // the subagent's log lines use its avatar color, like any agent with an avatar
    apply({ type: "log", id: "s1", message: "Baca file" });
    expect(S().logs.at(-1)?.color).not.toBe("#fff6e3");
  });

  it("removing the last subagent ends the meeting; the leader keeps its desk", () => {
    apply({ id: "lead", status: "working" });
    apply({ id: "s1", parent: "lead", status: "working" });
    apply({ type: "task_done", id: "s1" });
    expect(agent("lead").meeting).toBeNull();
    expect(agent("s1").meeting).toMatchObject({ room: 0 });
    apply({ type: "remove", id: "s1" });
    expect(S().meetings[0]).toBeNull();
    expect(meetingLogs().at(-1)).toMatch(/^Rapat selesai: Tim lead \(1 mnt\)$/);
    expect(agent("lead").slot).toBe(0);
  });

  it("a subagent without a seat (rooms full) takes a desk; with desks full too it is listed only", () => {
    for (let i = 0; i < 3; i++) {
      apply({ id: "l" + i, status: "working" });
      apply({ id: "s" + i, parent: "l" + i, status: "working" });
    }
    apply({ id: "l3", status: "working" });
    apply({ id: "s3", parent: "l3", status: "working" });
    expect(agent("s3")).toMatchObject({ meeting: null, slot: 4 });
    expect(meetingLogs()).toContain("Ruang meeting penuh, Tim l3 kerja di meja");
    for (let i = 5; i < DESK_SLOTS; i++) apply({ id: "x" + i });
    apply({ id: "s3b", parent: "l3", status: "working" });
    expect(agent("s3b")).toMatchObject({ meeting: null, slot: null });
    expect(S().logs.at(-1)?.message).toBe(`Meja penuh (maks ${DESK_SLOTS}), agen hanya tampil di daftar`);
  });

  it("a group from /api/event; clearing the group ends it", () => {
    apply({ id: "plonk", name: "Plonk", status: "working", group: "Rilis v2.3" });
    apply({ id: "vexa", name: "Vexa", status: "working", group: "Rilis v2.3" });
    expect(agent("plonk").meeting).toMatchObject({ room: 0, seat: 0, team: "Rilis v2.3" });
    expect(agent("vexa").meeting).toMatchObject({ seat: 1 });
    apply({ id: "vexa", group: null });
    expect(agent("plonk").meeting).toBeNull();
    expect(S().meetings[0]).toBeNull();
  });

  it("snapshot: members already in a meeting are placed at their seats", () => {
    apply({
      type: "snapshot",
      agents: [
        { id: "lead", status: "working", task: "Delegasi" },
        { id: "s1", parent: "lead", status: "working" },
      ],
    });
    expect(agent("lead").meeting).toMatchObject({ seat: 0 });
    // placed again once its subagent arrived and the meeting started (the first place was for its own entry)
    const after = signals.slice(signals.findIndex((x) => x.type === "add" && x.id === "s1"));
    expect(after).toContainEqual({ type: "place", id: "lead" });
  });

  it("demo: Glimbo delegates after 6 s; its subagents sit at its table without desks and leave again", () => {
    vi.useFakeTimers();
    try {
      const demo = createDemo(store);
      demo.start();
      vi.advanceTimersByTime(9000);
      const subs = [...S().agents.values()].filter((a) => a.parent === "glimbo");
      expect(subs.length).toBeGreaterThanOrEqual(2);
      // the demo group (Plonk and Vexa) may have taken Meeting A first
      const room = S().meetings.findIndex((r) => r?.leaderId === "glimbo");
      expect(S().meetings[room]).toMatchObject({ name: "Tim Glimbo" });
      expect(subs.every((a) => a.slot === null && a.meeting?.room === room)).toBe(true);
      vi.advanceTimersByTime(60_000);
      for (const a of subs) expect(S().agents.has(a.id)).toBe(false);
      demo.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clearAgents empties the rooms without log lines", () => {
    apply({ id: "lead", status: "working" });
    apply({ id: "s1", parent: "lead", status: "working" });
    S().clearAgents();
    expect(S().meetings.every((r) => r === null)).toBe(true);
    expect(S().logs).toEqual([]);
  });
});
