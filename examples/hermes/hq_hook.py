#!/usr/bin/env python3
"""Agent HQ shell hook for Hermes Agent.

Hermes runs this once per event and pipes one JSON object to stdin:
  {"hook_event_name", "session_id", "tool_name", "tool_input", "cwd", "extra": {...}}
The event is translated to Claude Code hook payloads and posted to Agent HQ's /api/hook, so the bridge
treats a Hermes session like a Claude Code session (statuses, bubbles, task board, confetti, rename).
The few states Claude Code hooks have no name for are posted to /api/event.

It never blocks Hermes: prints nothing, always exits 0, waits at most HQ_TIMEOUT seconds for Agent HQ,
and stops sending for 20 seconds after Agent HQ could not be reached.

  python3 hq_hook.py --dry-run < event.json   # print the requests instead of sending them
"""

import json
import os
import re
import sys
import time

import hq_common as hq

RETRY_AFTER = 20  # seconds without sending after Agent HQ was unreachable
CHILD_TTL = 30 * 60  # a subagent without a stop event for this long counts as gone

# Our own MCP tools, whatever the server is called: hq_mcp.py reports those itself.
HQ_TOOL = re.compile(r"(^|_)hq_(status|log|done|finding|alert|metric)$")
# clarify waits for the user; on_human_input_request shows that wait instead.
SKIP_TOOLS = {"clarify"}
PATCH_FILE = re.compile(r"\*\*\* (?:Update|Add|Delete) File: *(\S[^\n]*)")
DENIED = {"deny", "denied", "no", "n", "reject", "rejected", "block", "blocked", "timeout", "timed_out",
          "expired", "withdrawn", "cancel", "cancelled", "canceled", "error", "failed"}
CHILD_OK = {"", "completed", "complete", "success", "succeeded", "ok", "done", "finished"}
GENERIC_ROLES = {"", "leaf", "child", "subagent", "worker", "orchestrator", "default"}
# Hermes cron runs use session ids like cron_<job id>_<YYYYmmdd_HHMMSS> (cron/scheduler.py).
CRON_SESSION = re.compile(r"^cron_([0-9a-f]{6,32})_")


def cron_identity(job_id):
    """Name and role for a cron run's character: the job's name and schedule, not HQ_NAME."""
    job = next((j for j in hq.load_cron_jobs() if str(j.get("id")) == job_id), None)
    if not job:
        return {"name": "cron %s" % job_id[:6], "role": "Cron Hermes"}
    shown = hq.schedule_text(job)
    return {"name": hq.trunc(hq.redact(job.get("name") or job_id), 40),
            "role": hq.trunc("Cron · " + shown if shown else "Cron Hermes", 60)}


def first(*values):
    """First value that is not None or empty."""
    for v in values:
        if v is not None and v != "" and v != [] and v != {}:
            return v
    return None


def map_tool(name, tool_input):
    """Hermes tool -> (Claude Code tool name, tool_input), so the bridge labels it like Claude Code's."""
    i = tool_input if isinstance(tool_input, dict) else {}
    if name == "terminal":
        return "Bash", {"command": str(first(i.get("command"), ""))}
    if name in ("read_file", "write_file"):
        return ("Read" if name == "read_file" else "Write"), {"file_path": first(i.get("path"), i.get("file_path"))}
    if name == "patch":
        path = first(i.get("path"), i.get("file_path"))
        if not path:
            m = PATCH_FILE.search(str(i.get("patch") or ""))
            path = m.group(1).strip() if m else "file"
        return "Edit", {"file_path": path}
    if name == "search_files":
        pattern = str(first(i.get("pattern"), i.get("query"), ""))
        if str(i.get("target") or "").lower() in ("files", "file", "filename", "filenames", "name"):
            return "Glob", {"pattern": pattern}
        return "Grep", {"pattern": pattern}
    if name == "session_search":
        return "Grep", {"pattern": str(first(i.get("query"), ""))}
    if name == "web_search":
        return "WebSearch", {"query": str(first(i.get("query"), ""))}
    if name in ("web_extract", "browser_navigate"):
        urls = i.get("urls")
        return "WebFetch", {"url": str(first(i.get("url"), urls[0] if isinstance(urls, list) and urls else None) or "")}
    if name == "delegate_task":
        tasks = i.get("tasks")
        task0 = tasks[0] if isinstance(tasks, list) and tasks and isinstance(tasks[0], dict) else {}
        return "Task", {"description": str(first(i.get("goal"), task0.get("goal"), "subagen"))}
    if name == "todo":
        return "TodoWrite", {}
    if name in ("skill_view", "skills_list"):
        return "Read", {"file_path": str(first(i.get("name"), "skills"))}
    return name or "tool", {}


def tool_error(payload, extra):
    """Error text when a post_tool_call result is a failure, else None."""
    status = str(first(extra.get("status"), payload.get("status")) or "").lower()
    message = first(extra.get("error_message"), extra.get("error"))
    if status in ("error", "failed", "failure", "exception", "timeout") or extra.get("error_type"):
        return str(first(message, extra.get("error_type"), status))
    result = first(extra.get("result"), payload.get("tool_result"), payload.get("tool_response"))
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except ValueError:
            return None
    if isinstance(result, dict):
        if result.get("error"):
            return str(result["error"])
        code = result.get("exit_code")
        if isinstance(code, int) and not isinstance(code, bool) and code != 0:
            return "exit code %d" % code
    return None


class Translator:
    """One Hermes event -> list of (path, body) requests for Agent HQ. Updates the shared state in place."""

    def __init__(self, payload, state, now):
        self.p = payload
        self.x = payload.get("extra") if isinstance(payload.get("extra"), dict) else {}
        self.st = state
        self.now = now
        self.ppid = str(os.getppid())  # the Hermes process; hq_mcp.py has the same parent
        self.cwd = str(first(payload.get("cwd"), self.x.get("cwd")) or os.getcwd())
        self.out = []
        self.parent = "unknown"  # raw Hermes session id of the main agent
        self.sub = None  # subagent record when the event belongs to one
        self.cron_job = None  # job id when the main session is a cron run
        self.identity = None  # name/role headers overriding HQ_NAME/HQ_ROLE (cron runs)

    # ---- output

    def hook(self, event, **fields):
        body = {"hook_event_name": event, "session_id": hq.hook_session(self.parent), "cwd": self.cwd}
        if self.sub:
            body["agent_id"] = hq.short_hash(self.sub["key"], 8)
            body["agent_type"] = self.sub["type"]
        body.update({k: v for k, v in fields.items() if v is not None})
        self.out.append(("/api/hook", body))

    def event(self, **fields):
        fields["id"] = hq.agent_id(self.parent, self.sub["key"] if self.sub else None)
        self.out.append(("/api/event", fields))

    # ---- who is this event about

    def remember_main(self, raw):
        self.parent = raw
        self.st["sessions"].setdefault(raw, {})["at"] = self.now
        m = CRON_SESSION.match(raw)
        if m:
            # A cron run: its own character named after the job. It is not this process's interactive session,
            # so hq_mcp.py keeps reporting for that one.
            self.cron_job = m.group(1)
            self.identity = cron_identity(self.cron_job)
            return
        self.st["procs"][self.ppid] = {"sid": raw, "id": hq.agent_id(raw), "at": self.now}

    def last_main(self):
        return (self.st["procs"].get(self.ppid) or {}).get("sid") or "unknown"

    def running_children(self):
        limit = self.now - CHILD_TTL
        return [c for c in self.st["children"].values()
                if c.get("ppid") == self.ppid and not c.get("done") and c.get("at", 0) >= limit]

    def resolve(self, raw):
        key = self.st["child_sids"].get(raw) if raw else None
        sub = self.st["children"].get(key) if key else None
        if not sub and raw and raw not in self.st["sessions"]:
            # An unknown session id while a subagent runs in this Hermes process belongs to that subagent.
            running = self.running_children()
            if running:
                unbound = [c for c in running if not c.get("sid")]
                sub = max(unbound or running, key=lambda c: c.get("at", 0))
                if not sub.get("sid"):
                    sub["sid"] = raw
                    self.st["child_sids"][raw] = sub["key"]
        if sub:
            self.sub = sub
            self.parent = sub["parent"]
        else:
            self.remember_main(raw or self.last_main())

    # ---- events

    def run(self):
        ev = str(self.p.get("hook_event_name") or "")
        if ev == "subagent_start":
            self.subagent_start()
            return self.out
        if ev == "subagent_stop":
            self.subagent_stop()
            return self.out
        self.resolve(str(first(self.p.get("session_id"), self.x.get("session_id"), self.x.get("task_id")) or ""))
        x, main = self.x, self.sub is None
        tool = str(first(self.p.get("tool_name"), x.get("tool_name")) or "")

        if ev == "on_session_start":
            if main:
                self.session_start()
        elif ev == "pre_llm_call":
            if main:
                self.session_start()  # keeps SessionStart before the prompt whichever event comes first
            self.hook("UserPromptSubmit", prompt=str(first(x.get("user_message"), "")))
        elif ev == "pre_tool_call":
            if not HQ_TOOL.search(tool) and tool not in SKIP_TOOLS:
                name, tool_input = map_tool(tool, first(self.p.get("tool_input"), x.get("args")))
                self.hook("PreToolUse", tool_name=name, tool_input=tool_input)
        elif ev == "post_tool_call":
            error = None if HQ_TOOL.search(tool) else tool_error(self.p, x)
            if error:
                self.hook("PostToolUseFailure", tool_name=map_tool(tool, {})[0], error=error)
        elif ev == "pre_approval_request":
            command = str(first(x.get("command"), x.get("description"), ""))
            self.hook("PermissionRequest", tool_name="Bash", tool_input={"command": command})
        elif ev == "post_approval_response":
            if str(x.get("choice") or "").strip().lower() in DENIED:
                self.hook("PermissionDenied", tool_name="Bash")
                self.event(type="agent_update", status="thinking", task="Izin ditolak, mencari cara lain")
            else:
                self.event(type="agent_update", status="working", task="Izin diberikan, lanjut kerja")
        elif ev == "on_human_input_request":
            self.hook("Notification", notification_type="agent_needs_input",
                      message=str(first(x.get("prompt"), "Butuh jawabanmu")))
        elif ev == "on_human_input_resolved":
            self.event(type="agent_update", status="thinking", task="Lanjut setelah jawabanmu")
        elif ev == "post_llm_call":
            if main:  # a subagent's end is shown by subagent_stop
                self.hook("Stop", last_assistant_message=first(str(x.get("assistant_response") or "")[:1000]))
                self.end_children()
        elif ev == "on_session_end":
            # Fires after every turn. A finished turn already sent Stop from post_llm_call.
            if main and x.get("completed") is False:
                if x.get("interrupted") is True:
                    self.hook("Notification", notification_type="idle_prompt", message="")
                else:
                    self.hook("StopFailure", error=str(first(x.get("error"), "Hermes gagal menyelesaikan giliran")))
            if main and self.cron_job:
                # A cron run is one turn: its character goes offline and leaves after 5 minutes.
                self.hook("SessionEnd", reason="cron selesai")
                self.end_children()
        elif ev == "on_session_finalize":
            if main:
                self.hook("SessionEnd")
                self.st["sessions"][self.parent]["started"] = False
                self.end_children()
        return self.out

    def session_start(self):
        sess = self.st["sessions"][self.parent]
        if not sess.get("started"):
            sess["started"] = True
            self.hook("SessionStart", model=first(self.x.get("model")))

    def end_children(self):
        """Stop subagents of this session that never sent subagent_stop, so their characters leave."""
        main = self.sub
        for child in self.st["children"].values():
            if child.get("parent") == self.parent and not child.get("done"):
                child["done"] = True
                self.sub = child
                self.hook("SubagentStop")
        self.sub = main

    def main_of(self, raw):
        """Main session for a parent id that may itself be a subagent (nested delegation)."""
        key = self.st["child_sids"].get(raw)
        if key in self.st["children"]:
            return self.st["children"][key]["parent"]
        return raw or self.last_main()

    def subagent_start(self):
        x = self.x
        self.remember_main(self.main_of(str(first(x.get("parent_session_id"), self.p.get("session_id")) or "")))
        role = str(x.get("child_role") or "").strip()
        goal = hq.trunc(hq.redact(x.get("child_goal")), 40)
        sid = str(x.get("child_session_id") or "")
        key = str(first(x.get("child_subagent_id"), sid) or "sub-%d" % int(self.now * 1000))
        # agent_type names the character ("Subagen <type> mulai"); Hermes roles are mostly generic.
        kind = role if role.lower() not in GENERIC_ROLES else (goal or "subagen")
        self.sub = {"key": key, "parent": self.parent, "role": role, "type": kind,
                    "sid": sid, "ppid": self.ppid, "at": self.now, "done": False}
        self.st["children"][key] = self.sub
        if sid:
            self.st["child_sids"][sid] = key
        self.hook("SubagentStart")

    def subagent_stop(self):
        x = self.x
        children = self.st["children"]
        key = str(x.get("child_subagent_id") or "")
        if key not in children:
            sid = str(x.get("child_session_id") or "")
            key = self.st["child_sids"].get(sid) or (sid if sid in children else "")
        if key not in children:
            # No id in the event: the oldest running subagent of that parent with the same role.
            parent = self.main_of(str(first(x.get("parent_session_id"), self.p.get("session_id")) or ""))
            role = str(x.get("child_role") or "").strip()
            running = self.running_children()
            if not running:
                return
            key = min(running, key=lambda c: (c["parent"] != parent, c.get("role") != role, c.get("at", 0)))["key"]
        self.sub = children[key]
        self.parent = self.sub["parent"]
        status = str(x.get("child_status") or "").strip().lower()
        if status not in CHILD_OK:
            self.event(type="log", level="warn", message="Subagen %s: %s" % (self.sub["type"], hq.trunc(hq.redact(status), 60)))
        self.hook("SubagentStop", last_assistant_message=first(str(x.get("child_summary") or "")[:1000]))
        self.sub["done"] = True


def headers_for(path, cfg, body, identity=None):
    if path != "/api/hook":
        return {}
    ident = identity or {}
    return {
        "X-HQ-Name": ident.get("name") or cfg["name"],
        "X-HQ-Role": ident.get("role") or cfg["role"] or "Hermes · " + hq.project_name(body.get("cwd")),
        "X-HQ-Team": cfg["team"],
        "X-HQ-Group": cfg.get("group", ""),
    }


def run(argv):
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    try:
        payload = json.loads(raw) if raw.strip() else None
    except ValueError:
        return
    if not isinstance(payload, dict):
        return
    cfg = hq.load_config()
    if cfg["disabled"]:
        return
    dry = cfg["dry_run"] or "--dry-run" in argv
    now = time.time()
    with hq.State(cfg) as st:
        tr = Translator(payload, st.data, now)
        requests = tr.run()
        down_until = st.data.get("down_until", 0)
    if dry:
        for path, body in requests:
            line = {"path": path, "headers": headers_for(path, cfg, body, tr.identity), "body": body}
            sys.stdout.write(json.dumps(line, ensure_ascii=False) + "\n")
        return
    if not requests or down_until > now:
        return
    reachable = True
    for path, body in requests:
        status, error = hq.post(cfg, path, body, headers_for(path, cfg, body, tr.identity))
        if status == 0:
            reachable = False
            sys.stderr.write("agent-hq: %s tidak terjangkau (%s)\n" % (cfg["url"], error))
            break
        if not 200 <= status < 300:
            sys.stderr.write("agent-hq: %s %s\n" % (path, error))
    if not reachable or down_until:
        with hq.State(cfg) as st:
            st.data["down_until"] = 0 if reachable else now + RETRY_AFTER


def main(argv):
    try:
        run(argv)
    except Exception as e:  # never break Hermes because of Agent HQ
        sys.stderr.write("agent-hq hook: %s: %s\n" % (type(e).__name__, e))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
