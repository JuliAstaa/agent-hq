// Agent rename (prd.md §7.4, §8.2): overrides pinned by id, applied to every published event, persisted to a file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hookToEvents, type HookPayload } from "@/lib/bridge/hooks";
import { findAgent, hub, listAgents, publish, reloadOverrides, renameAgent, resetHub, type BridgeEvent } from "@/lib/bridge/hub";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hq-rename-"));
const FILE = path.join(DIR, "agent-hq-names.json");
const SID = "ab12cd34ef";
const CWD = "/Users/dev/projects/property-web";
const ID = "cc-ab12cd34";

let sent: BridgeEvent[] = [];
const hook = (h: HookPayload, headers: Record<string, string> = {}) => {
  for (const ev of hookToEvents({ session_id: SID, cwd: CWD, ...h }, (n) => headers[n], () => {})) publish(ev);
};
const fileAgents = () => JSON.parse(fs.readFileSync(FILE, "utf8")).agents as Record<string, Record<string, string>>;
const lastUpdate = () => [...sent].reverse().find((e) => e.type === "agent_update" && e.id === ID)!;

beforeEach(() => {
  resetHub();
  fs.rmSync(FILE, { force: true });
  reloadOverrides(FILE);
  sent = [];
  hub.subs.add((ev) => sent.push(ev));
});
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe("rename", () => {
  it("hook UserPromptSubmit names the agent <folder>#<4 of session>", () => {
    hook({ hook_event_name: "UserPromptSubmit", prompt: "cek staging" });
    expect(hub.agents.get(ID)).toMatchObject({ id: ID, name: "property-web#ab12" });
    expect(listAgents()).toEqual([{ id: ID, name: "property-web#ab12", role: "Claude Code · property-web", team: null, status: "thinking", renamed: false }]);
  });

  it("rename by displayed name sticks: the next PreToolUse hook keeps name Rexx and team red", () => {
    hook({ hook_event_name: "UserPromptSubmit", prompt: "cek staging" });
    const r = renameAgent({ type: "rename", match: "property-web#ab12", name: "Rexx", team: "red", role: "Pentester" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: true, id: ID, matchedBy: "name", before: { name: "property-web#ab12", team: null }, after: { name: "Rexx", team: "red", role: "Pentester" } });
    expect(lastUpdate()).toMatchObject({ name: "Rexx", team: "red", role: "Pentester" });
    expect(lastUpdate()).not.toHaveProperty("_renamed");

    hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "nmap -sV staging" } });
    expect(lastUpdate()).toMatchObject({ name: "Rexx", team: "red", role: "Pentester", status: "working", task: "$ nmap -sV staging" });
    expect(hub.agents.get(ID)).toMatchObject({ name: "Rexx", team: "red" });
    expect(fileAgents()[ID]).toMatchObject({ name: "Rexx", team: "red", role: "Pentester" });
  });

  it("an X-HQ-Name header on a later hook does not overwrite the rename", () => {
    hook({ hook_event_name: "SessionStart" });
    renameAgent({ type: "rename", match: "ab12", name: "Rexx" });
    hook({ hook_event_name: "UserPromptSubmit", prompt: "x" }, { "x-hq-name": "Other" });
    expect(lastUpdate().name).toBe("Rexx");
  });

  it("survives a restart: overrides are read back from the file", () => {
    hook({ hook_event_name: "UserPromptSubmit", prompt: "x" });
    renameAgent({ type: "rename", match: "property-web#ab12", name: "Rexx", team: "red" });
    resetHub();
    reloadOverrides(FILE); // what a fresh process does at start
    sent = [];
    hub.subs.add((ev) => sent.push(ev));
    hook({ hook_event_name: "SessionStart", source: "resume" });
    expect(lastUpdate()).toMatchObject({ name: "Rexx", team: "red" });
  });

  it("unknown match -> 404 that points at GET /agents; nothing written", () => {
    hook({ hook_event_name: "SessionStart" });
    const r = renameAgent({ type: "rename", match: "nope#0000", name: "X" });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ ok: false });
    expect(String(r.body.error)).toMatch(/GET \/agents/);
    expect(fs.existsSync(FILE)).toBe(false);
    expect(renameAgent({ type: "rename", id: "cc-zzzzzzzz", name: "X" }).status).toBe(404);
  });

  it("team null clears the team override and sends team office (back to the office desk)", () => {
    hook({ hook_event_name: "SessionStart" });
    renameAgent({ type: "rename", match: "ab12", name: "Rexx", team: "red" });
    const r = renameAgent({ type: "rename", match: "Rexx", team: null });
    expect(r.status).toBe(202);
    expect(fileAgents()[ID]).toEqual(expect.objectContaining({ name: "Rexx" }));
    expect(fileAgents()[ID]).not.toHaveProperty("team");
    expect(lastUpdate()).toMatchObject({ name: "Rexx", team: "office" });
    hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x/a.ts" } });
    expect(lastUpdate()).not.toHaveProperty("team");
    expect(hub.agents.get(ID)).toMatchObject({ name: "Rexx", team: "office" });
  });

  it("clearing every field removes the agent from the file and restores the hook name", () => {
    hook({ hook_event_name: "SessionStart" });
    renameAgent({ type: "rename", match: "ab12", name: "Rexx" });
    renameAgent({ type: "rename", id: ID, name: "" });
    expect(fileAgents()).toEqual({});
    expect(lastUpdate().name).toBe("property-web#ab12");
    expect(listAgents()[0]).toMatchObject({ name: "property-web#ab12", renamed: false });
  });

  it("matching: exact id, case-insensitive name, session prefix; main session wins over its subagents", () => {
    hook({ hook_event_name: "SessionStart" });
    hook({ hook_event_name: "SubagentStart", agent_id: "agent_77aa1234", agent_type: "recon-scout" });
    expect(findAgent(ID, undefined)).toEqual({ id: ID, matchedBy: "id" });
    expect(findAgent(undefined, "PROPERTY-WEB#AB12")).toEqual({ id: ID, matchedBy: "name" });
    expect(findAgent(undefined, "ab12")).toEqual({ id: ID, matchedBy: "prefix" });
    expect(findAgent(undefined, "cc-ab12cd")).toEqual({ id: ID, matchedBy: "prefix" });
    expect(findAgent(undefined, "recon-scout")).toMatchObject({ matchedBy: "name" });
    expect(findAgent(undefined, "")).toMatchObject({ status: 400 });
  });

  it("same name on two agents -> 409 with candidates", () => {
    publish({ type: "agent_update", id: "a1", name: "Twin" });
    publish({ type: "agent_update", id: "a2", name: "twin" });
    const r = renameAgent({ type: "rename", match: "TWIN", name: "X" });
    expect(r.status).toBe(409);
    expect(r.body.candidates).toEqual(["a1", "a2"]);
  });

  it("rejects a rename without fields or with a non-string value", () => {
    hook({ hook_event_name: "SessionStart" });
    expect(renameAgent({ type: "rename", match: "ab12" }).status).toBe(400);
    expect(renameAgent({ type: "rename", match: "ab12", name: 42 }).status).toBe(400);
    expect(renameAgent({ type: "rename", match: "ab12", name: "x".repeat(61) }).status).toBe(400);
  });

  it("metric, alert and finding events keep their own name field", () => {
    hook({ hook_event_name: "SessionStart" });
    renameAgent({ type: "rename", match: "ab12", name: "Rexx" });
    publish({ type: "metric", id: ID, name: "failed_logins", value: 3 });
    expect(sent.at(-1)).toMatchObject({ type: "metric", name: "failed_logins" });
  });
});
