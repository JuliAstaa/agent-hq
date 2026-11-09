import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSnapshot, saveSnapshot, stateFile, type BridgeSnapshot } from "@/lib/bridge/persistence";

type HubModule = typeof import("@/lib/bridge/hub");
let mod: HubModule | undefined;
let dir: string;
let file: string;

async function restart() {
  // Simulate process exit without touching its snapshot, then import a fresh hub.
  if (mod) for (const timer of mod.hub.removeTimers.values()) clearTimeout(timer);
  delete (globalThis as { __hq?: unknown }).__hq;
  vi.resetModules();
  mod = await import("@/lib/bridge/hub");
  return mod;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-persistence-"));
  file = path.join(dir, "state.json");
  vi.stubEnv("HQ_STATE_FILE", file);
  vi.stubEnv("HQ_NAMES_FILE", path.join(dir, "names.json"));
});

afterEach(() => {
  mod?.resetHub();
  mod = undefined;
  delete (globalThis as { __hq?: unknown }).__hq;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("bridge restart snapshots", () => {
  it("immediately saves agents, totals, identities and bounded recent events; restart needs no new hook", async () => {
    let h = await restart();
    h.publish({ id: "a", name: "A", role: "Coder", team: "blue", status: "working", task: "cek", tokens: 100 });
    h.publish({ id: "a", tokens_delta: 25, progress: 0.4 });
    h.publish({ id: "b", name: "B", status: "waiting" });
    for (let i = 0; i < 85; i++) h.publish({ type: "log", id: "a", message: `baris ${i}` });
    h.publish({ type: "finding", id: "a", title: "SSH", severity: "low" });
    h.publish({ type: "alert", title: "Login gagal", severity: "high" });
    const at = h.hub.lastSeen.get("a");
    expect(fs.existsSync(file)).toBe(true); // no debounce or shutdown handler required
    h = await restart();
    expect([...h.hub.agents.keys()]).toEqual(["a", "b"]);
    expect(h.hub.agents.get("a")).toMatchObject({ name: "A", status: "working", task: "cek", tokens: 125, progress: 0.4 });
    expect(h.hub.agents.get("b")).toMatchObject({ status: "waiting" });
    expect(h.hub.lastSeen.get("a")).toBe(at);
    expect(h.hub.sourceIdentity.get("a")).toEqual({ name: "A", role: "Coder", team: "blue" });
    expect(h.hub.recent).toHaveLength(80);
    expect(h.hub.recent.at(-1)).toMatchObject({ type: "alert" });
  });

  it("keeps a kicked agent out after a restart; activity brings it back with its name and tokens (prd.md §7.10)", async () => {
    let h = await restart();
    h.publish({ id: "a", name: "A", role: "Coder", status: "idle", tokens: 100 });
    expect(h.kickAgent({ type: "kick", id: "a" }).status).toBe(202);
    h = await restart();
    expect(h.hub.agents.has("a")).toBe(false);
    expect(h.hub.kicked.get("a")).toMatchObject({ agent: { id: "a", tokens: 100 }, source: { name: "A", role: "Coder" } });
    const sent: Record<string, unknown>[] = [];
    h.hub.subs.add((ev) => sent.push(ev));
    h.publish({ id: "a", status: "idle" });
    expect(sent).toEqual([]);
    h.publish({ id: "a", status: "working" });
    expect(sent[0]).toMatchObject({ id: "a", name: "A", role: "Coder", tokens: 100, status: "working" });
    h = await restart();
    expect(h.hub.kicked.size).toBe(0);
    expect(h.hub.agents.get("a")).toMatchObject({ name: "A", status: "working" });
  });

  it("drops kicks older than a week when it starts", async () => {
    const h0 = await restart();
    h0.publish({ id: "a", status: "idle" });
    h0.kickAgent({ type: "kick", id: "a" });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.kicked[0][1].at = Date.now() - 8 * 24 * 3600 * 1000;
    fs.writeFileSync(file, JSON.stringify(raw));
    const h = await restart();
    expect(h.hub.kicked.size).toBe(0);
    expect(loadSnapshot(file)?.kicked).toEqual([]);
  });

  it("keeps rename overrides and the original identity when a rename is cleared after restart", async () => {
    let h = await restart();
    h.publish({ id: "a", name: "Asli", role: "Coder", status: "idle" });
    expect(h.renameAgent({ id: "a", name: "Rexx" }).status).toBe(202);
    h = await restart();
    expect(h.listAgents()[0]).toMatchObject({ name: "Rexx", renamed: true });
    h.renameAgent({ id: "a", name: null });
    expect(h.listAgents()[0]).toMatchObject({ name: "Asli", renamed: false });
  });

  it("never resurrects explicitly removed agents", async () => {
    let h = await restart();
    h.publish({ id: "a", status: "idle" });
    h.scheduleRemove("a", 300000);
    h.publish({ type: "remove", id: "a" });
    h = await restart();
    expect(h.hub.agents.size).toBe(0);
    expect(h.hub.removeTimers.size).toBe(0);
    expect(h.hub.sourceIdentity.size).toBe(0);
  });

  it("subagents leave with their session, live and when its removal expired during downtime; a kick keeps them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
    let h = await restart();
    const sent: string[] = [];
    h.hub.subs.add((ev) => { if (ev.type === "remove") sent.push(`${ev.id}${ev.reason ? ":" + ev.reason : ""}`); });
    h.publish({ id: "lead", status: "idle" });
    h.publish({ id: "lead-sub", parent: "lead", status: "error" });
    h.publish({ id: "other", status: "idle" });
    h.kickAgent({ id: "lead" });
    expect(h.hub.agents.has("lead-sub")).toBe(true);
    h.publish({ type: "remove", id: "lead" });
    expect(sent).toEqual(["lead:kick", "lead", "lead-sub"]);
    expect([...h.hub.agents.keys()]).toEqual(["other"]);

    h.publish({ id: "s2", status: "idle" });
    h.publish({ id: "s2-sub", parent: "s2", status: "error" });
    h.publish({ id: "s2-sub-sub", parent: "s2-sub", status: "idle" });
    h.scheduleRemove("s2", 300000);
    vi.setSystemTime(Date.now() + 600000); // the session's removal expires while the process is stopped
    h = await restart();
    expect([...h.hub.agents.keys()]).toEqual(["other"]);
    expect(loadSnapshot(file)?.agents.map((a) => a.id)).toEqual(["other"]);
  });

  it("resumes the remaining removal delay, expires during downtime, and keeps reactivated sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    let h = await restart();
    for (const id of ["sub", "ended", "resumed"]) h.publish({ id, status: "idle" });
    h.scheduleRemove("sub", 45000);
    h.scheduleRemove("ended", 300000);
    h.scheduleRemove("resumed", 45000);
    vi.advanceTimersByTime(100);
    h.publish({ id: "resumed", status: "working" });
    vi.setSystemTime(Date.now() + 30000); // time passing while the process is stopped
    h = await restart();
    expect(h.hub.agents.has("sub")).toBe(true);
    vi.advanceTimersByTime(14900);
    expect(h.hub.agents.has("sub")).toBe(false);
    expect(h.hub.agents.has("resumed")).toBe(true);
    vi.setSystemTime(Date.now() + 300000);
    h = await restart();
    expect([...h.hub.agents.keys()]).toEqual(["resumed"]);
    expect(loadSnapshot(file)?.agents.map((a) => a.id)).toEqual(["resumed"]);
  });

  it("redacts persisted prompts, names and replay messages, including raw event producers", async () => {
    let h = await restart();
    h.publish({ id: "a", name: "token=name-secret", task: "token=prompt-secret", status: "working" });
    h.publish({ type: "log", id: "a", message: "mysql -u root -pcommand-secret" });
    const raw = fs.readFileSync(file, "utf8");
    for (const secret of ["name-secret", "prompt-secret", "command-secret"]) expect(raw).not.toContain(secret);
    h = await restart();
    expect(h.hub.agents.get("a")?.task).toBe("token=***");
    expect(h.hub.recent[0].message).toBe("mysql -u root -p***");
  });

  it("storage errors do not interrupt publication and the next event retries the save", async () => {
    const h = await restart();
    const events: unknown[] = [];
    h.hub.subs.add((ev) => events.push(ev));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const write = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => h.publish({ id: "a", status: "working" })).not.toThrow();
    expect(events).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    write.mockRestore();
    h.publish({ id: "a", tokens: 42 });
    expect(loadSnapshot(file)?.agents[0]).toMatchObject({ id: "a", tokens: 42 });
  });

  it("does not rewrite snapshots for server metrics or schedule polling", async () => {
    const h = await restart();
    const write = vi.spyOn(fs, "writeFileSync");
    h.publish({ type: "server_stats" });
    h.publish({ type: "schedule", jobs: [] });
    h.publish({ type: "cron_command", id: "cmd" });
    expect(write).not.toHaveBeenCalled();
  });
});

describe("snapshot files", () => {
  const empty: BridgeSnapshot = { version: 1, agents: [], recent: [], lastSeen: [], sourceIdentity: [], removals: [] };

  it("handles missing, corrupt and unsupported files without throwing or logging file contents", () => {
    expect(loadSnapshot(file)).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const raw of ["broken token=private", "null", '{"version":99}', '{"version":1,"agents":{}}']) {
      fs.writeFileSync(file, raw);
      expect(loadSnapshot(file)).toBeNull();
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  });

  it("leaves the old snapshot readable if atomic rename fails, and cleans the temp file", () => {
    saveSnapshot(file, empty);
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("rename failed"); });
    expect(() => saveSnapshot(file, { ...empty, agents: [{ id: "new" }] })).toThrow("rename failed");
    expect(loadSnapshot(file)?.agents).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
  });

  it("uses a data directory outside the checkout, supports a custom file, opt-out and build isolation", () => {
    expect(stateFile()).toBe(file);
    vi.stubEnv("HQ_STATE_FILE", "0");
    expect(stateFile()).toBeNull();
    vi.stubEnv("HQ_STATE_FILE", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("XDG_STATE_HOME", dir);
    expect(stateFile()).toBe(path.join(dir, "agent-hq", "state.json"));
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    expect(stateFile()).toBeNull();
  });
});
