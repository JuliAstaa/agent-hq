import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHQStore, type HQStore, type Signal } from "@/lib/store";
import { createDemo, DEMO } from "@/lib/demo";
import { avatarColor } from "@/lib/palette";

let store: HQStore;
let signals: Signal[];
const S = () => store.getState();
const apply = (ev: unknown) => S().applyEvent(ev);
const agent = (id: string) => S().agents.get(id)!;
const logMsgs = () => S().logs.map((l) => `${l.level}|${l.name}|${l.message}`);

beforeEach(() => {
  store = createHQStore();
  signals = [];
  S().onSignal((s) => signals.push(s));
});

describe("agent lifecycle", () => {
  it("new agent defaults, add signal, desk slot", () => {
    apply({ id: "a" });
    expect(agent("a")).toMatchObject({ id: "a", name: "a", role: "Agen", status: "idle", task: "", tokens: 0, cost: null, progress: null, slot: 0 });
    expect(signals).toEqual([{ type: "add", id: "a" }]);
  });

  it("status transition logs and squashes; quiet does not log", () => {
    apply({ id: "a", name: "Glimbo", task: "Fix bug" });
    apply({ id: "a", status: "working" });
    expect(logMsgs()).toEqual(["info|Glimbo|Santai → Kerja · Fix bug"]);
    expect(signals.at(-1)).toEqual({ type: "squash", id: "a" });
    apply({ id: "a", status: "waiting", task: "Perlu API key" });
    expect(S().logs.at(-1)).toMatchObject({ level: "warn", message: "Kerja → Butuh kamu · Perlu API key" });
    apply({ type: "snapshot", agents: [{ id: "a", status: "idle" }] });
    expect(S().logs).toHaveLength(2);
  });

  it("task_done celebrates, counts, logs, sets progress 1", () => {
    apply({ id: "a", status: "working", task: "T1", progress: 30 });
    signals = [];
    apply({ type: "task_done", id: "a", status: "idle", task: "T1", tokens_delta: 400 });
    expect(S().stats.done).toBe(1);
    expect(agent("a")).toMatchObject({ status: "idle", progress: 1, tokens: 400 });
    expect(signals).toEqual([{ type: "confetti", id: "a" }, { type: "squash", id: "a" }]);
    expect(S().logs.map((l) => l.message)).toContain("Selesai: T1");
    apply({ id: "a", status: "completed" });
    expect(S().stats.done).toBe(2);
  });

  it("error counting does not double count", () => {
    apply({ id: "a", status: "working" });
    apply({ id: "a", status: "error" });
    expect(S().stats.errors).toBe(1);
    apply({ type: "log", id: "a", level: "error", message: "boom" });
    expect(S().stats.errors).toBe(1);
    apply({ id: "b", status: "working" });
    apply({ type: "log", id: "b", level: "error", message: "boom", status: "error" });
    expect(S().stats.errors).toBe(1);
    expect(agent("b").status).toBe("error");
    apply({ type: "log", id: "c", level: "error", message: "x" });
    expect(S().stats.errors).toBe(2);
  });

  it("agent events: task updates and logs, max 60", () => {
    apply({ id: "a", task: "one" });
    apply({ id: "a", task: "two" });
    expect(agent("a").events.map((e) => e.msg)).toEqual(["one", "two"]);
    for (let i = 0; i < 70; i++) apply({ type: "log", id: "a", message: "m" + i });
    expect(agent("a").events).toHaveLength(60);
  });

  it("desks full after 9: roster only + warn (deviation 17)", () => {
    for (let i = 0; i < 10; i++) apply({ id: "a" + i });
    expect(agent("a8").slot).toBe(8);
    expect(agent("a9").slot).toBeNull();
    expect(S().logs.at(-1)).toMatchObject({ level: "warn", message: "Meja penuh (maks 9), agen hanya tampil di daftar", color: "#fff6e3" });
    apply({ type: "remove", id: "a3" });
    apply({ id: "late" });
    expect(agent("late").slot).toBe(3);
  });

  it("remove clears selection and signals", () => {
    apply({ id: "a" });
    S().select("a");
    apply({ type: "remove", id: "a" });
    expect(S().agents.has("a")).toBe(false);
    expect(S().selectedId).toBeNull();
    expect(signals.at(-1)).toEqual({ type: "remove", id: "a" });
  });

  it("log lines carry avatar color only for agents with a desk; cap 220", () => {
    apply({ id: "a", name: "A" });
    S().pushLog({ id: "a", message: "hi" });
    S().pushLog({ id: "ghost", message: "boo" });
    expect(S().logs.at(-2)).toMatchObject({ name: "A", color: avatarColor("a") });
    expect(S().logs.at(-1)).toMatchObject({ name: "ghost", color: "#fff6e3", level: "info" });
    for (let i = 0; i < 300; i++) S().pushLog({ id: "x", message: String(i) });
    expect(S().logs).toHaveLength(220);
    expect(S().logs.at(-1)!.message).toBe("299");
  });

  it("move logs do not enter agent events", () => {
    apply({ id: "a" });
    S().pushLog({ id: "a", level: "move", message: "Jalan santai, ke Lounge (Lt.1)" });
    expect(agent("a").events).toHaveLength(0);
  });

  it("alert/finding do not rename an existing agent", () => {
    apply({ id: "sentra", name: "Sentra" });
    apply({ type: "alert", id: "sentra", name: "Other", message: "m" });
    expect(agent("sentra").name).toBe("Sentra");
    apply({ type: "finding", id: "newbie", name: "Newbie", title: "t" });
    expect(agent("newbie").name).toBe("Newbie");
  });
});

describe("teams (prd.md §10.2)", () => {
  it("task keywords are sticky until idle/offline", () => {
    apply({ id: "p", role: "Claude Code · lab", status: "working", task: "$ nmap -sV staging" });
    expect(agent("p").dept).toBe("red");
    apply({ id: "p", task: "$ ls -la" });
    expect(agent("p").dept).toBe("red");
    apply({ id: "p", status: "idle" });
    expect(agent("p")).toMatchObject({ dept: null, deptSticky: null });
    apply({ id: "p", status: "working", task: "$ ls" });
    expect(agent("p").dept).toBeNull();
  });
  it("explicit team wins; office forces the desk", () => {
    apply({ id: "q", status: "working", task: "nmap", team: "blue" });
    expect(agent("q").dept).toBe("blue");
    apply({ id: "q", team: "office" });
    expect(agent("q").dept).toBeNull();
  });
  it("role keywords after idle", () => {
    apply({ id: "s", role: "SOC Analyst", status: "idle" });
    expect(agent("s").dept).toBe("blue");
  });
});

describe("security", () => {
  it("finding updates the VA board and attack nodes", () => {
    apply({ type: "finding", id: "rexx", severity: "high", title: "SQL injection di /login" });
    apply({ type: "finding", severity: "critical", title: "SSH root login" });
    apply({ type: "finding", severity: "low", title: "SSH banner" });
    expect(S().vuln.counts).toEqual({ critical: 1, high: 1, medium: 0, low: 1, info: 0 });
    expect(S().vuln.list.map((f) => f.title)).toEqual(["SSH banner", "SSH root login", "SQL injection di /login"]);
    expect(S().vuln.nodes).toEqual(["WEB", "SSH"]);
    expect(S().agents.has("rexx")).toBe(true);
    expect(S().agents.size).toBe(1);
    expect(S().logs.map((l) => `${l.level}|${l.name}|${l.message}`)).toContain("find|VA|Temuan Critical: SSH root login");
  });
  it("alert flashes and toasts; replayed alert does neither", () => {
    apply({ type: "alert", severity: "high", message: "Bruteforce SSH", source_ip: "10.0.0.9" });
    expect(signals).toEqual([{ type: "alert", text: "Bruteforce SSH", ip: "10.0.0.9", sev: "high" }]);
    expect(S().toast?.msg).toBe("Alert SOC: Bruteforce SSH");
    expect(S().logs.at(-1)).toMatchObject({ level: "alert", name: "SOC", message: "ALERT High: Bruteforce SSH · 10.0.0.9" });
    signals = [];
    const toastBefore = S().toast;
    apply({ type: "alert", severity: "critical", message: "old", _replay: true });
    expect(signals).toEqual([]);
    expect(S().toast).toBe(toastBefore);
    expect(S().soc.total).toBe(2);
    apply({ type: "alert", severity: "medium", message: "meh" });
    expect(S().toast).toBe(toastBefore);
    for (let i = 0; i < 10; i++) apply({ type: "alert", message: "x" + i });
    expect(S().soc.alerts).toHaveLength(6);
  });
  it("login metrics reach the engine, others are ignored", () => {
    apply({ type: "metric", name: "failed_logins", value: 37 });
    apply({ type: "metric", name: "cpu", value: 90 });
    expect(signals).toEqual([{ type: "metric", value: 37 }]);
    expect(S().agents.size).toBe(0);
  });
});

describe("snapshot placement and reset", () => {
  it("snapshot emits place for agents with a desk", () => {
    apply({ type: "snapshot", agents: [{ id: "a", status: "idle" }, { id: "b", status: "working", task: "nmap" }] });
    expect(signals).toEqual([{ type: "add", id: "a" }, { type: "place", id: "a" }, { type: "add", id: "b" }, { type: "squash", id: "b" }, { type: "place", id: "b" }]);
  });
  it("clearAgents resets everything", () => {
    apply({ id: "a", status: "error" });
    apply({ type: "finding", title: "x" });
    apply({ type: "alert", message: "y" });
    S().clearAgents();
    expect(S()).toMatchObject({ logs: [], stats: { done: 0, errors: 0 }, soc: { alerts: [], total: 0 } });
    expect(S().agents.size).toBe(0);
    expect(S().vuln.nodes).toEqual([]);
    expect(signals.slice(-2)).toEqual([{ type: "remove", id: "a" }, { type: "reset" }]);
  });
});

describe("ui state", () => {
  it("floor and focus signals", () => {
    apply({ id: "a" });
    signals = [];
    S().setFloor("security");
    S().setFloor("kantor", false);
    S().select("a", true);
    S().select("missing", true);
    expect(S().floorMode).toBe("kantor");
    expect(S().selectedId).toBe("missing");
    expect(signals).toEqual([{ type: "floor", floor: "security", moveCam: true }, { type: "floor", floor: "kantor", moveCam: false }, { type: "focus", id: "a" }]);
  });
  it("setLocs only updates changed agents", () => {
    apply({ id: "a" });
    apply({ id: "b" });
    const before = S().agents;
    S().setLocs(new Map([["a", { where: "Meja kerja · Kantor", what: "" }]]));
    expect(S().agents).not.toBe(before);
    expect(S().agents.get("b")).toBe(before.get("b"));
    const after = S().agents;
    S().setLocs(new Map([["a", { where: "Meja kerja · Kantor", what: "" }]]));
    expect(S().agents).toBe(after);
  });
  it("conn defaults", () => {
    S().setConn("live");
    expect(S().conn).toEqual({ mode: "live", text: "Live" });
    S().setConn("down", "Menyambung...");
    expect(S().conn.text).toBe("Menyambung...");
  });
});

describe("demo simulator", () => {
  it("starts with the 9 demo agents (one per desk, deviation 17) and keeps running", () => {
    vi.useFakeTimers();
    const demo = createDemo(store);
    demo.start();
    expect([...S().agents.keys()]).toEqual(DEMO.map((d) => d.id));
    expect(DEMO).toHaveLength(9);
    expect([...S().agents.values()].every((a) => a.slot != null)).toBe(true); // every demo agent gets a desk
    expect(agent("rexx")).toMatchObject({ status: "working", dept: "red" });
    expect(agent("plonk").status).toBe("idle");
    expect(S().conn.mode).toBe("demo");
    expect(S().logs.at(-1)?.message).toBe("Mode demo aktif. Klik agen untuk zoom, pilih area di atas.");
    vi.advanceTimersByTime(120_000);
    expect(S().logs.length).toBeGreaterThan(10);
    demo.stop();
    expect(demo.running).toBe(false);
    vi.useRealTimers();
  });
});
