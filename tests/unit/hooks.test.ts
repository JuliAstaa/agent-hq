import { describe, expect, it, vi } from "vitest";
import { describeTool, hookToEvents, type HookPayload } from "@/lib/bridge/hooks";

const SID = "5f3c9a1e-7b2d-4c11-9e0f-0123456789ab";
const CWD = "/Users/dev/projects/shop-api";
const noHeaders = () => null;
const run = (h: HookPayload, headers: Record<string, string> = {}) => {
  const sched = vi.fn();
  const out = hookToEvents({ session_id: SID, cwd: CWD, ...h }, (n) => headers[n], sched);
  return { out, sched };
};

describe("identity (prd.md §8.2)", () => {
  it("main session id, name, role from repo folder", () => {
    const { out } = run({ hook_event_name: "SessionStart", source: "startup", model: "claude-opus-5-5" });
    expect(out).toEqual([{ type: "agent_update", id: "cc-5f3c9a1e", name: "shop-api#5f3c", role: "Claude Code · shop-api", source: "claude-code", status: "idle", task: "Sesi startup di shop-api · claude-opus-5-5" }]);
  });
  it("headers override name/role and add team", () => {
    const { out } = run({ hook_event_name: "SessionStart" }, { "x-hq-name": "Rexx", "x-hq-role": "Pentester", "x-hq-team": " red " });
    expect(out[0]).toMatchObject({ name: "Rexx", role: "Pentester", team: "red", task: "Sesi baru di shop-api" });
  });
  it("empty headers (unset env vars) fall back", () => {
    const { out } = run({ hook_event_name: "SessionStart" }, { "x-hq-name": "", "x-hq-role": "", "x-hq-team": "" });
    expect(out[0]).toMatchObject({ name: "shop-api#5f3c", role: "Claude Code · shop-api" });
    expect(out[0]).not.toHaveProperty("team");
  });
  it("subagent id and name", () => {
    const { out } = run({ hook_event_name: "SubagentStart", agent_id: "agent-9f8e7d6c5b", agent_type: "code-reviewer-with-a-long-name" });
    expect(out[0]).toMatchObject({ id: "cc-5f3c9a-agent-9f", name: "code-reviewer-wit…", role: "Subagen · shop-api", status: "working", task: "Subagen code-reviewer-with-a-long-name mulai" });
  });
  it("missing session and cwd", () => {
    const out = hookToEvents({ hook_event_name: "SessionStart" }, noHeaders, vi.fn());
    expect(out[0]).toMatchObject({ id: "cc-unknown", name: "claude#unkn", role: "Claude Code · claude" });
  });
});

describe("hook -> event mapping (prd.md §8.3)", () => {
  it("UserPromptSubmit redacts and truncates the prompt", () => {
    const { out } = run({ hook_event_name: "UserPromptSubmit", prompt: "deploy with token=abc123 " + "x".repeat(200) });
    expect(out[0]).toMatchObject({ status: "thinking", progress: null });
    expect(out[0].task).toMatch(/^deploy with token=\*\*\* x+…$/);
    expect(String(out[0].task).length).toBe(140);
    expect(out[1]).toEqual({ type: "log", id: "cc-5f3c9a1e", level: "info", message: "Prompt baru masuk" });
  });
  it("PreToolUse: working + log, quiet tools skip the log", () => {
    const bash = run({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "nmap -sV staging" } }).out;
    expect(bash).toHaveLength(2);
    expect(bash[0]).toMatchObject({ status: "working", task: "$ nmap -sV staging" });
    expect(bash[1]).toMatchObject({ type: "log", message: "Bash: $ nmap -sV staging" });
    for (const t of ["Read", "Grep", "Glob", "TodoWrite", "TaskUpdate", "TaskCreate"]) {
      expect(run({ hook_event_name: "PreToolUse", tool_name: t, tool_input: {} }).out).toHaveLength(1);
    }
  });
  it("PostToolUseFailure", () => {
    expect(run({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", error: "exit 1" }).out).toEqual([{ type: "log", id: "cc-5f3c9a1e", level: "warn", message: "Bash gagal: exit 1" }]);
  });
  it("PermissionRequest / PermissionDenied", () => {
    const pr = run({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf build" } }).out;
    expect(pr[0]).toMatchObject({ status: "waiting", task: "Minta izin: $ rm -rf build" });
    expect(pr[1]).toMatchObject({ level: "warn", message: "Menunggu izin untuk Bash" });
    expect(run({ hook_event_name: "PermissionDenied", tool_name: "Bash" }).out[0]).toMatchObject({ level: "warn", message: "Izin ditolak: Bash" });
  });
  it("Notification types", () => {
    for (const t of ["permission_prompt", "agent_needs_input", "elicitation_dialog", "elicitation_url_dialog"]) {
      const out = run({ hook_event_name: "Notification", notification_type: t, message: "Claude needs your permission" }).out;
      expect(out[0]).toMatchObject({ status: "waiting", task: "Claude needs your permission" });
      expect(out[1]).toMatchObject({ level: "warn" });
    }
    expect(run({ hook_event_name: "Notification", notification_type: "idle_prompt" }).out[0]).toMatchObject({ status: "idle", task: "Menunggu prompt berikutnya" });
    expect(run({ hook_event_name: "Notification", notification_type: "auth_success" }).out).toEqual([{ type: "log", id: "cc-5f3c9a1e", level: "info", message: "Butuh perhatian" }]);
  });
  it("Stop -> task_done + last message; SubagentStop schedules removal", () => {
    const stop = run({ hook_event_name: "Stop", last_assistant_message: "Done. password=xyz" });
    expect(stop.out[0]).toMatchObject({ type: "task_done", status: "idle", id: "cc-5f3c9a1e" });
    expect(stop.out[1]).toMatchObject({ message: "Selesai: Done. password=***" });
    expect(stop.sched).not.toHaveBeenCalled();
    const sub = run({ hook_event_name: "SubagentStop", agent_id: "abcdef123456", agent_type: "Explore" });
    expect(sub.out).toHaveLength(1);
    expect(sub.sched).toHaveBeenCalledWith("cc-5f3c9a-abcdef12", 45000);
  });
  it("StopFailure, PreCompact, Task*, SessionEnd, unknown", () => {
    const sf = run({ hook_event_name: "StopFailure", error: "rate_limit" }).out;
    expect(sf[0]).toMatchObject({ status: "error" });
    expect(sf[1]).toMatchObject({ level: "error", message: "Gagal berhenti normal: rate_limit" });
    expect(run({ hook_event_name: "PreCompact" }).out[0]).toMatchObject({ status: "thinking", task: "Merangkum konteks (compact)" });
    expect(run({ hook_event_name: "TaskCreated", task: { subject: "Write tests" } }).out[0]).toMatchObject({ message: "Tugas baru: Write tests" });
    expect(run({ hook_event_name: "TaskCompleted", subject: "Write tests" }).out[0]).toMatchObject({ message: "Tugas selesai: Write tests" });
    const end = run({ hook_event_name: "SessionEnd", reason: "logout" });
    expect(end.out[0]).toMatchObject({ status: "offline", task: "Sesi selesai (logout)" });
    expect(end.sched).toHaveBeenCalledWith("cc-5f3c9a1e", 300000);
    expect(run({ hook_event_name: "PostToolUse" }).out).toEqual([]);
  });
});

describe("describeTool", () => {
  it("covers the PRD list", () => {
    expect(describeTool("Bash", { command: "echo token=abc " + "y".repeat(200) })).toMatch(/^\$ echo token=\*\*\* y+…$/);
    expect(describeTool("Bash", { command: "a".repeat(200) }).length).toBe(92);
    expect(describeTool("Edit", { file_path: "/r/auth.go" })).toBe("Edit auth.go");
    expect(describeTool("MultiEdit", { file_path: "/r/a.ts" })).toBe("Edit a.ts");
    expect(describeTool("Write", { file_path: "/r/new.ts" })).toBe("Menulis new.ts");
    expect(describeTool("NotebookEdit", { notebook_path: "/r/n.ipynb" })).toBe("Edit notebook n.ipynb");
    expect(describeTool("Read", { file_path: "/r/x.md" })).toBe("Baca x.md");
    expect(describeTool("Grep", { pattern: "TODO" })).toBe('Cari "TODO"');
    expect(describeTool("Glob", { pattern: "**/*.ts" })).toBe("Cari file **/*.ts");
    expect(describeTool("WebSearch", { query: "three.js outline" })).toBe("Search: three.js outline");
    expect(describeTool("WebFetch", { url: "https://docs.example.com/a?b" })).toBe("Buka docs.example.com");
    expect(describeTool("WebFetch", { url: "not a url" })).toBe("Buka halaman web");
    expect(describeTool("Task", { description: "Review diff" })).toBe("Delegasi: Review diff");
    expect(describeTool("Agent", { subagent_type: "Explore" })).toBe("Delegasi: Explore");
    expect(describeTool("Agent", {})).toBe("Delegasi: subagen");
    expect(describeTool("TodoWrite", {})).toBe("Update daftar tugas");
    expect(describeTool("mcp__github__create_issue", {})).toBe("MCP github: create_issue");
    expect(describeTool("Skill", null)).toBe("Skill");
    expect(describeTool("", {})).toBe("tool");
  });
});
