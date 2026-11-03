import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowedQuirks, CHAT_BY_ACTIVITY, CHAT_BY_DEPT, CHAT_IDLE, CHAT_REPLIES, CHAT_THINKING, CHAT_WORKING, chatLine,
  MAX_CHATS, newFun, QUIRK_DUR, startQuirk, tickFun, type ChatSlots, type FunInfo,
} from "@/engine/agents/fun";

const idleAtSofa: FunInfo = { status: "idle", mode: "act", pose: "sit", activity: "tv", dept: null, visible: true };
const run = (f: ReturnType<typeof newFun>, info: FunInfo, from: number, seconds: number, slots: ChatSlots, dt = 0.05) => {
  const steps = [];
  for (let t = from; t < from + seconds; t += dt) steps.push({ t, ...tickFun(f, info, t, dt, slots) });
  return steps;
};

afterEach(() => vi.restoreAllMocks());

describe("chat lines", () => {
  const all = [...CHAT_IDLE, ...Object.values(CHAT_BY_ACTIVITY).flat(), ...CHAT_WORKING, ...Object.values(CHAT_BY_DEPT).flat(), ...CHAT_THINKING, ...CHAT_REPLIES] as string[];
  it("includes the requested one", () => {
    expect(CHAT_IDLE).toContain("makan mie ayam enak nih");
  });
  it("are short, non-empty, and never use em dashes", () => {
    for (const l of all) {
      expect(l.length).toBeGreaterThan(0);
      expect(l.length).toBeLessThanOrEqual(32);
      expect(l).not.toMatch(/[—]/);
    }
  });
  it("match the context", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    expect(CHAT_BY_ACTIVITY.coffee).toContain(chatLine({ status: "idle", mode: "act", activity: "coffee", dept: null }));
    expect(CHAT_THINKING).toContain(chatLine({ status: "thinking", mode: "desk", activity: null, dept: null }));
    expect(CHAT_BY_DEPT.red).toContain(chatLine({ status: "working", mode: "desk", activity: null, dept: "red" }));
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    expect(CHAT_WORKING).toContain(chatLine({ status: "working", mode: "desk", activity: null, dept: "red" }));
    expect(CHAT_IDLE).toContain(chatLine({ status: "idle", mode: "act", activity: "coffee", dept: null }));
  });
});

describe("allowedQuirks", () => {
  it("depends on the pose", () => {
    expect(allowedQuirks({ status: "idle", mode: "act", pose: "stand" })).toContain("hop");
    expect(allowedQuirks({ status: "idle", mode: "act", pose: "sit" })).not.toContain("hop");
    expect(allowedQuirks({ status: "idle", mode: "act", pose: "lie" })).toEqual(["yawn", "stretch", "lookaround"]);
    expect(allowedQuirks({ status: "working", mode: "desk", pose: "desk" })).toContain("spin");
  });
  it("never while the agent needs the human, errors, is offline, walks, fetches or carries a card", () => {
    for (const status of ["waiting", "error", "offline"] as const) expect(allowedQuirks({ status, mode: "act", pose: "stand" })).toEqual([]);
    expect(allowedQuirks({ status: "idle", mode: "walk", pose: "walk" })).toEqual([]);
    expect(allowedQuirks({ status: "working", mode: "fetch", pose: "fetch" })).toEqual([]);
    expect(allowedQuirks({ status: "working", mode: "desk", pose: "desk", carrying: true })).toEqual([]);
  });
});

describe("tickFun", () => {
  it("stays calm for the first 8 s (actions) and 12 s (chat)", () => {
    const slots = { open: 0 };
    const f = newFun(0);
    const steps = run(f, idleAtSofa, 0, 7.9, slots);
    expect(steps.some((s) => s.quirk)).toBe(false);
    expect(steps.some((s) => s.said)).toBe(false);
    expect(f.nextQuirk).toBeGreaterThanOrEqual(8);
    expect(f.nextChat).toBeGreaterThanOrEqual(12);
  });

  it("eventually acts and talks, and each action ends after its duration", () => {
    const slots = { open: 0 };
    const f = newFun(0);
    const steps = run(f, idleAtSofa, 0, 120, slots);
    const started = steps.find((s) => s.quirk)!;
    expect(started).toBeTruthy();
    expect(steps.some((s) => s.said)).toBe(true);
    const end = steps.findIndex((s) => s.t > started.t + QUIRK_DUR[started.quirk!] + 0.1);
    expect(steps.slice(end).length).toBeGreaterThan(0);
    expect(slots.open).toBeLessThanOrEqual(1);
  });

  it("balloons close after a few seconds and free their slot", () => {
    const slots = { open: 0 };
    const f = newFun(0);
    f.nextChat = 0;
    expect(tickFun(f, idleAtSofa, 0, 0.05, slots).said).toBeTruthy();
    expect(slots.open).toBe(1);
    run(f, idleAtSofa, 0.05, 5, slots);
    expect(f.chat).toBeNull();
    expect(slots.open).toBe(0);
  });

  it("at most MAX_CHATS balloons at once", () => {
    const slots = { open: MAX_CHATS };
    const f = newFun(0);
    f.nextChat = 0;
    expect(tickFun(f, idleAtSofa, 0, 0.05, slots).said).toBeUndefined();
    expect(f.nextChat).toBeGreaterThan(0);
  });

  it("drops the balloon and the action when the status turns urgent", () => {
    const slots = { open: 0 };
    const f = newFun(0);
    f.nextChat = 0;
    tickFun(f, idleAtSofa, 0, 0.05, slots);
    startQuirk(f, "stretch");
    const out = tickFun(f, { ...idleAtSofa, status: "waiting" }, 0.1, 0.05, slots);
    expect(out.closed).toBe(true);
    expect(f.chat).toBeNull();
    expect(f.quirk).toBeNull();
    expect(slots.open).toBe(0);
  });

  it("hidden agents (other floor) do not talk", () => {
    const slots = { open: 0 };
    const f = newFun(0);
    f.nextChat = 0;
    expect(tickFun(f, { ...idleAtSofa, visible: false }, 0, 0.05, slots).said).toBeUndefined();
  });

  it("a scheduled reply is said once and flagged as a reply", () => {
    const slots = { open: 0 };
    const f = newFun(0);
    f.reply = { text: "wkwk", at: 1 };
    expect(tickFun(f, idleAtSofa, 0.5, 0.05, slots).said).toBeUndefined();
    const out = tickFun(f, idleAtSofa, 1, 0.05, slots);
    expect(out).toMatchObject({ said: "wkwk", isReply: true });
    expect(f.reply).toBeNull();
  });
});
