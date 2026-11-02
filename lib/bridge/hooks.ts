// Claude Code hook payload -> Agent HQ events (prd.md §8). Port of hookToEvents() in references/server.js.

import { base, redact, trunc } from "./redact";
import type { BridgeEvent } from "./hub";

/* eslint-disable @typescript-eslint/no-explicit-any -- raw hook JSON, shape varies per event */
export type HookPayload = Record<string, any>;

/** Header lookup by lower-case name; missing header -> null/undefined. */
export type HeaderGet = (name: string) => string | null | undefined;

export function describeTool(name: string, input: any = {}): string {
  const i = input || {};
  if (name === "Bash") return `$ ${trunc(redact(i.command || i.description), 90)}`;
  if (name === "Write") return `Menulis ${base(i.file_path)}`;
  if (name === "Edit" || name === "MultiEdit") return `Edit ${base(i.file_path)}`;
  if (name === "NotebookEdit") return `Edit notebook ${base(i.notebook_path)}`;
  if (name === "Read") return `Baca ${base(i.file_path)}`;
  if (name === "Grep") return `Cari "${trunc(i.pattern, 40)}"`;
  if (name === "Glob") return `Cari file ${trunc(i.pattern, 40)}`;
  if (name === "WebSearch") return `Search: ${trunc(i.query, 60)}`;
  if (name === "WebFetch") {
    try {
      return `Buka ${new URL(i.url).host}`;
    } catch {
      return "Buka halaman web";
    }
  }
  if (name === "Task" || name === "Agent") return `Delegasi: ${trunc(i.description || i.subagent_type || "subagen", 60)}`;
  if (name === "TodoWrite" || name === "TaskCreate" || name === "TaskUpdate") return "Update daftar tugas";
  if (/^mcp__/.test(name)) {
    const [, srv, tool] = name.split("__");
    return `MCP ${srv}: ${tool}`;
  }
  return name || "tool";
}

export const QUIET_TOOLS = new Set(["Read", "Grep", "Glob", "TodoWrite", "TaskUpdate", "TaskCreate"]);

export function hookToEvents(
  h: HookPayload,
  hdr: HeaderGet,
  scheduleRemove: (id: string, ms: number) => void,
): BridgeEvent[] {
  const evName = h.hook_event_name;
  const sid = String(h.session_id || "unknown");
  const proj = base(h.cwd) || "claude";
  const isSub = !!h.agent_id;
  const id = isSub ? `cc-${sid.slice(0, 6)}-${String(h.agent_id).slice(0, 8)}` : `cc-${sid.slice(0, 8)}`;
  const team = (hdr("x-hq-team") || "").trim();
  const who = {
    id,
    name: isSub ? trunc(h.agent_type || "subagen", 18) : hdr("x-hq-name") || `${proj}#${sid.slice(0, 4)}`,
    role: isSub ? `Subagen · ${proj}` : hdr("x-hq-role") || `Claude Code · ${proj}`,
    ...(team ? { team } : {}),
    source: "claude-code",
  };
  const up = (extra: BridgeEvent): BridgeEvent => ({ type: "agent_update", ...who, ...extra });
  const log = (message: unknown, level = "info"): BridgeEvent => ({ type: "log", id, level, message: trunc(redact(message), 180) });
  const tool = h.tool_name;

  switch (evName) {
    case "SessionStart":
      return [up({ status: "idle", task: `Sesi ${h.source || "baru"} di ${proj}${h.model ? " · " + h.model : ""}` })];
    case "UserPromptSubmit":
      return [up({ status: "thinking", task: trunc(redact(h.prompt || "Prompt baru"), 140), progress: null }), log("Prompt baru masuk")];
    case "PreToolUse": {
      const d = describeTool(tool, h.tool_input);
      const out = [up({ status: "working", task: d })];
      if (!QUIET_TOOLS.has(tool)) out.push(log(`${tool}: ${d}`));
      return out;
    }
    case "PostToolUseFailure":
      return [log(`${tool || "Tool"} gagal: ${trunc(h.error || h.message || "", 120)}`, "warn")];
    case "PermissionRequest":
      return [up({ status: "waiting", task: `Minta izin: ${describeTool(tool, h.tool_input)}` }), log(`Menunggu izin untuk ${tool}`, "warn")];
    case "PermissionDenied":
      return [log(`Izin ditolak: ${tool || ""}`, "warn")];
    case "Notification": {
      const t = String(h.notification_type || "");
      const msg = h.message || "Butuh perhatian";
      if (/permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog/.test(t)) {
        return [up({ status: "waiting", task: trunc(msg, 120) }), log(msg, "warn")];
      }
      if (t === "idle_prompt") return [up({ status: "idle", task: "Menunggu prompt berikutnya" })];
      return [log(msg)];
    }
    case "Stop":
    case "SubagentStop": {
      const out: BridgeEvent[] = [{ type: "task_done", ...who, status: "idle" }];
      if (h.last_assistant_message) out.push(log(`Selesai: ${h.last_assistant_message}`));
      if (evName === "SubagentStop") scheduleRemove(id, 45000);
      return out;
    }
    case "StopFailure":
      return [up({ status: "error" }), log(`Gagal berhenti normal: ${h.error || h.message || evName}`, "error")];
    case "SubagentStart":
      return [up({ status: "working", task: `Subagen ${h.agent_type || ""} mulai` })];
    case "PreCompact":
      return [up({ status: "thinking", task: "Merangkum konteks (compact)" })];
    case "TaskCreated":
    case "TaskCompleted":
      return [log(`${evName === "TaskCreated" ? "Tugas baru" : "Tugas selesai"}: ${h.task?.subject || h.subject || h.description || ""}`)];
    case "SessionEnd":
      scheduleRemove(id, 5 * 60 * 1000);
      return [up({ status: "offline", task: `Sesi selesai${h.reason ? " (" + h.reason + ")" : ""}` })];
    default:
      return [];
  }
}
