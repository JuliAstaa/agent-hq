import { describe, expect, it } from "vitest";
import { normalizeEvent, normStatus, STATUS_ALIAS, findingNode, type HQEvent, type AgentPatch } from "@/lib/events";

const NOW = 1_700_000_000_000;
const one = (raw: unknown): HQEvent => {
  const out = normalizeEvent(raw, NOW);
  expect(out).toHaveLength(1);
  return out[0];
};
const agentOf = (raw: unknown): AgentPatch => {
  const e = one(raw);
  if (e.kind !== "agent") throw new Error("expected agent event, got " + e.kind);
  return e.agent;
};

describe("normStatus", () => {
  it("keeps canonical statuses", () => {
    for (const s of ["working", "thinking", "waiting", "idle", "error", "offline"]) expect(normStatus(s)).toBe(s);
  });
  it("maps every alias", () => {
    for (const [k, v] of Object.entries(STATUS_ALIAS)) expect(normStatus(k)).toBe(v);
  });
  it("normalizes case, spaces and dashes", () => {
    expect(normStatus("  Needs Input ")).toBe("waiting");
    expect(normStatus("needs-input")).toBe("waiting");
    expect(normStatus("TOOL CALL")).toBe("working");
  });
  it("PRD aliases (§7.1)", () => {
    expect(normStatus("running")).toBe("working");
    expect(normStatus("busy")).toBe("working");
    expect(normStatus("blocked")).toBe("waiting");
    expect(normStatus("needs_input")).toBe("waiting");
    expect(normStatus("done")).toBe("idle");
    expect(normStatus("completed")).toBe("idle");
    expect(normStatus("failed")).toBe("error");
    expect(normStatus("stopped")).toBe("offline");
  });
  it("empty -> null, unknown -> working", () => {
    expect(normStatus(undefined)).toBeNull();
    expect(normStatus("")).toBeNull();
    expect(normStatus("banana")).toBe("working");
    expect(normStatus("constructor")).toBe("working");
  });
});

describe("agent_update (§7.1)", () => {
  it("normalizes the PRD example", () => {
    const a = agentOf({ type: "agent_update", id: "coder-1", name: "Glimbo", role: "Coder", status: "working", task: "Refactor handler auth", progress: 0.4, tokens: 18230, team: "red" });
    expect(a).toMatchObject({ type: "agent_update", id: "coder-1", name: "Glimbo", role: "Coder", status: "working", task: "Refactor handler auth", progress: 0.4, tokens: 18230, team: "red", updatedAt: NOW, quiet: false, snap: false });
  });
  it("defaults type to agent_update and id from fallbacks", () => {
    expect(agentOf({ status: "busy" })).toMatchObject({ type: "agent_update", id: "agent", status: "working" });
    expect(agentOf({ agent_id: "a1" }).id).toBe("a1");
    expect(agentOf({ agentId: "a2" }).id).toBe("a2");
    expect(agentOf({ agent: "a3" }).id).toBe("a3");
    expect(agentOf({ name: "Zed" }).id).toBe("Zed");
    expect(agentOf({ id: 7 }).id).toBe("7");
  });
  it("uses `event` as type and treats bare message as log", () => {
    expect(agentOf({ event: "TASK_DONE", id: "x" }).type).toBe("task_done");
    expect(agentOf({ id: "x", message: "hi" }).type).toBe("log");
    expect(agentOf({ id: "x", message: "hi", status: "idle" }).type).toBe("agent_update");
  });
  it("progress 0..1 or 0..100, clamped", () => {
    expect(agentOf({ id: "x", progress: 40 }).progress).toBe(0.4);
    expect(agentOf({ id: "x", progress: 0.25 }).progress).toBe(0.25);
    expect(agentOf({ id: "x", progress: 250 }).progress).toBe(1);
    expect(agentOf({ id: "x", progress: -3 }).progress).toBe(0);
    expect(agentOf({ id: "x", progress: null }).progress).toBeUndefined();
  });
  it("tokens absolute and tokens_delta", () => {
    expect(agentOf({ id: "x", tokens: "1200" }).tokens).toBe(1200);
    expect(agentOf({ id: "x", tokens: "abc" }).tokens).toBe(0);
    expect(agentOf({ id: "x", tokens_delta: 300 }).tokensDelta).toBe(300);
  });
  it("task from task/current_task/activity/step", () => {
    expect(agentOf({ id: "x", current_task: "a" }).task).toBe("a");
    expect(agentOf({ id: "x", activity: "b" }).task).toBe("b");
    expect(agentOf({ id: "x", step: 3 }).task).toBe("3");
    expect(agentOf({ id: "x" }).task).toBeUndefined();
  });
  it("team field: aliases, office, keyword fallback", () => {
    expect(agentOf({ id: "x", team: "Blue Team" }).team).toBe("blue");
    expect(agentOf({ id: "x", team: "SOC" }).team).toBe("blue");
    expect(agentOf({ id: "x", team: "office" }).team).toBeNull();
    expect(agentOf({ id: "x", room: "pentest lab" }).team).toBe("red");
    expect(agentOf({ id: "x", dept: "laporan" }).team).toBe("report");
    expect(agentOf({ id: "x", team: "marketing" }).team).toBeNull();
    expect("team" in agentOf({ id: "x" })).toBe(false);
  });
  it("status from `state`, done flags, ts", () => {
    expect(agentOf({ id: "x", state: "failed" }).status).toBe("error");
    expect(agentOf({ id: "x", status: "completed" }).statusDone).toBe(true);
    expect(agentOf({ id: "x", ts: "2026-01-02T03:04:05.000Z" }).updatedAt).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
    expect(agentOf({ id: "x", ts: "garbage" }).updatedAt).toBe(NOW);
  });
});

describe("log, task_done, remove, snapshot (§7.2)", () => {
  it("log", () => {
    const a = agentOf({ type: "log", id: "coder-1", level: "WARN", message: "..." });
    expect(a).toMatchObject({ type: "log", level: "warn", message: "..." });
    expect(agentOf({ type: "log", id: "x", text: "t" })).toMatchObject({ level: "info", message: "t" });
    expect(agentOf({ type: "log", id: "x", status: "error" }).statusFieldError).toBe(true);
  });
  it("task_done", () => {
    expect(agentOf({ type: "task_done", id: "coder-1", task: "T" })).toMatchObject({ type: "task_done", id: "coder-1", task: "T", status: null });
  });
  it("remove", () => {
    expect(one({ type: "remove", id: "coder-1" })).toEqual({ kind: "remove", id: "coder-1", kicked: false });
  });
  it("remove with reason kick (prd.md §7.10); a kick command is not an agent event", () => {
    expect(one({ type: "remove", id: "coder-1", reason: "kick" })).toEqual({ kind: "remove", id: "coder-1", kicked: true });
    expect(normalizeEvent({ type: "kick", id: "coder-1" })).toEqual([]);
  });
  it("snapshot -> quiet agent updates", () => {
    const out = normalizeEvent({ type: "snapshot", agents: [{ id: "a", status: "idle" }, { id: "b", name: "B", type: "log" }] }, NOW);
    expect(out).toHaveLength(2);
    for (const e of out) {
      expect(e.kind).toBe("agent");
      if (e.kind === "agent") expect(e.agent).toMatchObject({ type: "agent_update", quiet: true, snap: true });
    }
    expect(normalizeEvent({ type: "snapshot" }, NOW)).toEqual([]);
  });
  it("arrays and junk", () => {
    expect(normalizeEvent([{ id: "a" }, null, 3, [{ id: "b" }]], NOW)).toHaveLength(2);
    expect(normalizeEvent("x", NOW)).toEqual([]);
    expect(normalizeEvent(null, NOW)).toEqual([]);
  });
});

describe("security events (§7.3)", () => {
  it("finding with id", () => {
    const e = one({ type: "finding", id: "rexx", severity: "critical", title: "SQL injection di /login" });
    expect(e).toMatchObject({ kind: "finding", agentId: "rexx", sev: "critical", title: "SQL injection di /login", node: "WEB" });
    if (e.kind === "finding") expect(e.agent).toMatchObject({ type: "finding", id: "rexx" });
  });
  it("finding without id creates no agent; severity mapping", () => {
    const e = one({ type: "finding", severity: "moderate", title: "x" });
    expect(e).toMatchObject({ kind: "finding", agentId: null, sev: "medium", agent: null });
    expect(one({ type: "finding", severity: "informational" })).toMatchObject({ sev: "info", title: "Temuan baru" });
    expect(one({ type: "finding", severity: "weird" })).toMatchObject({ sev: "medium" });
    expect(one({ type: "finding", level: "LOW", message: "m" })).toMatchObject({ sev: "low", title: "m" });
  });
  it("finding node by keyword", () => {
    expect(findingNode("SSH izinkan password login")).toBe("SSH");
    expect(findingNode("Dump database pelanggan")).toBe("DB");
    expect(findingNode("IDOR di /api/booking/{id}")).toBe("API");
    expect(findingNode("Panel admin tanpa rate limit")).toBe("ADMIN");
    expect(findingNode("XSS di komentar")).toBe("WEB");
  });
  it("alert", () => {
    const e = one({ type: "alert", id: "sentra", severity: "high", message: "Bruteforce SSH 412x/2 mnt", source_ip: "103.94.12.7" });
    expect(e).toMatchObject({ kind: "alert", agentId: "sentra", sev: "high", text: "Bruteforce SSH 412x/2 mnt", ip: "103.94.12.7", replay: false });
    expect(one({ type: "alert" })).toMatchObject({ agentId: null, sev: "high", text: "Aktivitas mencurigakan", ip: "", agent: null });
    expect(one({ type: "alert", severity: "nope", title: "t", ip: "1.2.3.4", _replay: true })).toMatchObject({ sev: "high", text: "t", ip: "1.2.3.4", replay: true });
  });
  it("metric", () => {
    expect(one({ type: "metric", name: "failed_logins", value: 37 })).toEqual({ kind: "metric", name: "failed_logins", value: 37, login: true });
    expect(one({ type: "metric", name: "cpu", value: "x" })).toEqual({ kind: "metric", name: "cpu", value: 0, login: false });
    expect(one({ type: "metric", value: 5 })).toMatchObject({ login: true });
  });
});
