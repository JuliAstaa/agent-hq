// Kick (prd.md §7.10): who may be kicked, what brings a kicked agent back, the bridge filter in publish(), the
// /api/event command, and the roster client (live and demo).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canKick, KICK_TTL_MS, kickAgent as kickFromRoster, kickRefusal, wakesUp } from "@/lib/kick";
import { setLiveUrlSource } from "@/lib/rename";
import { saveToken } from "@/lib/token";
import { hookToEvents, type HookPayload } from "@/lib/bridge/hooks";
import { agentKnown, hub, kickAgent, listAgents, publish, reloadOverrides, renameAgent, resetHub, type BridgeEvent } from "@/lib/bridge/hub";
import { POST as postEvent } from "@/app/api/event/route";
import type { Status } from "@/lib/events";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hq-kick-"));
const SID = "ab12cd34ef";
const CWD = "/Users/dev/projects/property-web";
const ID = "cc-ab12cd34";

let sent: BridgeEvent[] = [];
const hook = (h: HookPayload) => {
  for (const ev of hookToEvents({ session_id: SID, cwd: CWD, ...h }, () => undefined, () => {})) publish(ev);
};
const kick = (id = ID) => kickAgent({ type: "kick", id });

beforeEach(() => {
  resetHub();
  fs.rmSync(path.join(DIR, "names.json"), { force: true });
  reloadOverrides(path.join(DIR, "names.json"));
  sent = [];
  hub.subs.add((ev) => sent.push(ev));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("rules", () => {
  it("only idle and offline agents can be kicked", () => {
    const all: Status[] = ["working", "thinking", "waiting", "idle", "error", "offline"];
    expect(all.filter(canKick)).toEqual(["idle", "offline"]);
    expect(kickRefusal("Rexx", "working")).toBe("Rexx berstatus Kerja. Hanya agen Santai atau Offline yang bisa dikeluarkan.");
  });

  it("activity brings a kicked agent back; idle, offline, tokens, logs and task_done do not", () => {
    for (const s of ["thinking", "working", "waiting", "error"] as Status[]) expect(wakesUp("agent_update", s)).toBe(true);
    for (const s of ["idle", "offline", null] as (Status | null)[]) expect(wakesUp("agent_update", s)).toBe(false);
    expect(wakesUp("task_done", "idle")).toBe(false);
    expect(wakesUp("log", null)).toBe(false);
    expect(wakesUp("finding", null)).toBe(true);
    expect(wakesUp("alert", null)).toBe(true);
  });
});

describe("bridge kick", () => {
  it("kicks an idle agent: one remove with reason kick, gone from the snapshot and the agent list", () => {
    hook({ hook_event_name: "SessionStart" });
    sent = [];
    const r = kick();
    expect(r).toEqual({ status: 202, body: { ok: true, kicked: true, id: ID, name: "property-web#ab12", matchedBy: "id" } });
    expect(sent).toEqual([expect.objectContaining({ type: "remove", id: ID, reason: "kick" })]);
    expect(hub.agents.has(ID)).toBe(false);
    expect(listAgents()).toEqual([]);
    expect(agentKnown(ID)).toBe(true);
  });

  it("kicks an offline agent (a session that ended, like a deleted Hermes session)", () => {
    hook({ hook_event_name: "SessionEnd" });
    expect(kick().status).toBe(202);
  });

  it("refuses an agent that is working, thinking, waiting or in error (409), and changes nothing", () => {
    for (const [ev, status] of [["UserPromptSubmit", "thinking"], ["PreToolUse", "working"], ["PermissionRequest", "waiting"], ["StopFailure", "error"]] as const) {
      hook({ hook_event_name: ev, tool_name: "Bash", tool_input: { command: "ls" } });
      sent = [];
      const r = kick();
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ ok: false, id: ID, status, error: expect.stringContaining("Hanya agen Santai atau Offline") });
      expect(sent).toEqual([]);
      expect(hub.agents.has(ID)).toBe(true);
      expect(hub.kicked.size).toBe(0);
    }
  });

  it("unknown agent: 404; no id or match: 400 that names the kick", () => {
    expect(kick("cc-nope").status).toBe(404);
    expect(kickAgent({ type: "kick" })).toMatchObject({ status: 400, body: { error: 'kick butuh "id" atau "match"' } });
  });

  it("idle prompts, session starts, token counts and logs keep a kicked agent out", () => {
    hook({ hook_event_name: "SessionStart" });
    publish({ type: "agent_update", id: ID, tokens: 500 });
    kick();
    sent = [];
    hook({ hook_event_name: "Notification", notification_type: "idle_prompt" });
    hook({ hook_event_name: "SessionStart", source: "resume" });
    hook({ hook_event_name: "Notification", notification_type: "auth_success", message: "ok" });
    publish({ type: "agent_update", id: ID, tokens: 900 });
    publish({ type: "task_done", id: ID });
    expect(sent).toEqual([]);
    expect(hub.agents.has(ID)).toBe(false);
    expect(hub.recent).toEqual([]);
    expect(hub.kicked.get(ID)?.agent).toMatchObject({ tokens: 900 }); // the kept record stays current
  });

  it("a metric from a kicked agent still counts, without bringing the agent back", () => {
    hook({ hook_event_name: "SessionStart" });
    kick();
    sent = [];
    publish({ type: "metric", id: ID, name: "failed_logins", value: 7 });
    expect(sent).toEqual([expect.objectContaining({ type: "metric", name: "failed_logins", value: 7 })]);
    expect(sent[0]).not.toHaveProperty("id");
    expect(hub.agents.has(ID)).toBe(false);
  });

  it("comes back on activity with its name, role, team and tokens; later events are normal again", () => {
    hook({ hook_event_name: "SessionStart" });
    publish({ type: "agent_update", id: ID, tokens: 500, team: "red" });
    kick();
    publish({ type: "agent_update", id: ID, status: "idle", tokens: 650 });
    sent = [];
    // a bare status update (Hermes chat sends these) still gets the identity back
    publish({ type: "agent_update", id: ID, status: "thinking" });
    expect(sent).toEqual([expect.objectContaining({ type: "agent_update", id: ID, status: "thinking", name: "property-web#ab12", role: "Claude Code · property-web", tokens: 650, team: "red" })]);
    expect(hub.agents.get(ID)).toMatchObject({ name: "property-web#ab12", status: "thinking", tokens: 650, team: "red" });
    expect(hub.kicked.size).toBe(0);
    sent = [];
    hook({ hook_event_name: "Notification", notification_type: "idle_prompt" });
    expect(sent).toHaveLength(1);
  });

  it("a renamed agent comes back under its new name", () => {
    hook({ hook_event_name: "SessionStart" });
    renameAgent({ type: "rename", id: ID, name: "Rexx" });
    kick();
    sent = [];
    hook({ hook_event_name: "UserPromptSubmit", prompt: "lanjut" });
    expect(sent[0]).toMatchObject({ type: "agent_update", id: ID, name: "Rexx", status: "thinking" });
  });

  it("a finding from a kicked agent brings it back", () => {
    hook({ hook_event_name: "SessionStart" });
    kick();
    sent = [];
    publish({ type: "finding", id: ID, severity: "high", title: "SQL injection di /login" });
    expect(sent[0]).toMatchObject({ type: "finding", name: "property-web#ab12" });
    expect(hub.agents.has(ID)).toBe(true);
  });

  it("a remove ends the kick (for example the 5 minute removal after SessionEnd)", () => {
    hook({ hook_event_name: "SessionStart" });
    kick();
    publish({ type: "remove", id: ID });
    expect(hub.kicked.size).toBe(0);
    sent = [];
    hook({ hook_event_name: "SessionStart" });
    expect(sent).toHaveLength(1);
  });

  it("a kick expires after KICK_TTL_MS: the agent then comes back like a new one", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    hook({ hook_event_name: "SessionStart" });
    kick();
    vi.setSystemTime(1_000_000 + KICK_TTL_MS + 1);
    sent = [];
    hook({ hook_event_name: "SessionStart" });
    expect(sent).toHaveLength(1);
    expect(hub.kicked.size).toBe(0);
  });
});

describe("POST /api/event kick", () => {
  const post = (body: unknown) => postEvent(new Request("http://localhost:8787/api/event", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  beforeEach(() => vi.stubEnv("HQ_TOKEN", ""));

  it("a single kick answers with its own result; a refused one with 409", async () => {
    hook({ hook_event_name: "SessionStart" });
    let res = await post({ type: "kick", id: ID });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, kicked: true, id: ID });
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
    res = await post({ type: "kick", match: "property-web#ab12" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, status: "working" });
  });

  it("arrays report kicks next to the other events", async () => {
    const res = await post([{ id: "a", status: "idle" }, { type: "kick", id: "a" }]);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, received: 2, kicks: [{ ok: true, id: "a" }] });
    expect(sent.map((e) => [e.type ?? "agent_update", e.reason])).toEqual([["agent_update", undefined], ["remove", "kick"]]);
  });
});

describe("roster kick client", () => {
  const stub = (mode: string, status: Status = "idle") => {
    const applied: unknown[] = [];
    const agents = new Map([["a", { name: "Zorp", status }]]);
    return { applied, store: { getState: () => ({ conn: { mode }, agents, applyEvent: (ev: unknown) => applied.push(ev) }) } };
  };
  afterEach(() => {
    setLiveUrlSource(() => null);
    vi.unstubAllGlobals();
  });

  it("demo: kicks on this screen only", async () => {
    const { store, applied } = stub("demo");
    expect(await kickFromRoster(store, "a")).toEqual({ ok: true, local: true });
    expect(applied).toEqual([{ type: "remove", id: "a", reason: "kick" }]);
  });

  it("refuses a working agent before asking the bridge", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { store } = stub("live", "working");
    expect(await kickFromRoster(store, "a")).toEqual({ ok: false, error: kickRefusal("Zorp", "working") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("live: posts the kick next to the stream and reads the answer", async () => {
    setLiveUrlSource(() => "http://localhost:8787/api/stream");
    const answers = [
      new Response(JSON.stringify({ ok: true, kicked: true }), { status: 202 }),
      new Response(JSON.stringify({ ok: true, received: 1 }), { status: 202 }), // a bridge without kicks
      new Response(JSON.stringify({ ok: false, error: "Zorp berstatus Kerja." }), { status: 409 }),
      new Response('{"ok":false}', { status: 401 }),
    ];
    const fetchMock = vi.fn(async () => answers.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const { store } = stub("live");
    expect(await kickFromRoster(store, "a")).toEqual({ ok: true, local: false });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:8787/api/event", expect.objectContaining({ method: "POST", body: JSON.stringify({ type: "kick", id: "a" }) }));
    expect(await kickFromRoster(store, "a")).toEqual({ ok: false, error: "Bridge ini belum mendukung kick agen." });
    expect(await kickFromRoster(store, "a")).toEqual({ ok: false, error: "Zorp berstatus Kerja." });
    expect(await kickFromRoster(store, "a")).toMatchObject({ ok: false, error: expect.stringContaining("HQ_TOKEN") });
  });

  it("live: sends the HQ_TOKEN typed in this tab, and asks for it on a 401", async () => {
    setLiveUrlSource(() => "/api/stream");
    const saved = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });
    const fetchMock = vi.fn(async () => new Response('{"ok":false,"error":"token salah"}', { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const headers = (i: number) => (fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].headers;
    const { store } = stub("live");
    expect(await kickFromRoster(store, "a")).toEqual({ ok: false, error: "Agent HQ memakai HQ_TOKEN. Masukkan tokennya dulu.", needToken: true });
    expect(headers(0)).toEqual({ "content-type": "application/json" });
    saveToken(" rahasia ");
    expect(await kickFromRoster(store, "a")).toEqual({ ok: false, error: "Token salah. Masukkan lagi.", needToken: true });
    expect(headers(1)).toEqual({ "content-type": "application/json", authorization: "Bearer rahasia" });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true, kicked: true }), { status: 202 }));
    expect(await kickFromRoster(store, "a")).toEqual({ ok: true, local: false });
    expect(headers(2)).toEqual({ "content-type": "application/json", authorization: "Bearer rahasia" });
  });
});
