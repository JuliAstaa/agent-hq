#!/usr/bin/env python3
"""Agent HQ MCP server (stdio) for Hermes Agent and other MCP clients.

Gives the AI tools for what only it knows: progress, notable log lines, finished work, Red Team findings,
SOC alerts and the failed-login metric. Each call becomes Agent HQ events (POST /api/event).

Which character reports: when hq_hook.py runs in the same Hermes process, the reports go to the character
the hooks created. Otherwise this server has its own character (HQ_NAME, HQ_ROLE, HQ_TEAM); with
HQ_ANNOUNCE=1 it appears as soon as the client connects.

MCP over stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout, logs on stderr.
Python 3.8+ standard library only.
"""

import json
import os
import re
import socket
import sys

import hq_common as hq

SERVER_INFO = {"name": "agent-hq", "version": "1.0.0"}
DEFAULT_PROTOCOL = "2025-06-18"
STATUSES = ["working", "thinking", "waiting", "idle", "error"]
SEVERITIES = ["critical", "high", "medium", "low", "info"]

INSTRUCTIONS = (
    "Agent HQ shows the user a live 3D office in which you are a character. When Agent HQ hooks are "
    "installed your ordinary tool use is shown automatically, so use these tools only for what the office "
    "cannot see: hq_status with a short task and progress when you start a multi-step job or reach a "
    "milestone, hq_finding for each security finding, hq_alert for suspicious activity you detect, "
    "hq_metric for failed-login counts, hq_log for notable results, and hq_done once when the job is "
    "finished. Keep texts short, never include secrets, and do not retry a report that failed."
)


def _schema(props, required=()):
    return {"type": "object", "properties": props, "required": list(required), "additionalProperties": False}


TOOLS = [
    {
        "name": "hq_status",
        "description": "Show your current status and task in Agent HQ. Call when you start a multi-step job, "
                       "switch phase, or reach a milestone, not after every tool call.",
        "inputSchema": _schema({
            "status": {"type": "string", "enum": STATUSES},
            "task": {"type": "string", "description": "What you are doing, under 100 characters, in the user's language."},
            "progress": {"type": "number", "minimum": 0, "maximum": 1, "description": "Fraction done, 0 to 1."},
        }, ["status"]),
    },
    {
        "name": "hq_log",
        "description": "Add one line to the Agent HQ activity log for a notable result (test suite outcome, "
                       "deploy, warning). Not for routine steps.",
        "inputSchema": _schema({
            "message": {"type": "string", "description": "Under 160 characters."},
            "level": {"type": "string", "enum": ["info", "warn", "error"]},
        }, ["message"]),
    },
    {
        "name": "hq_done",
        "description": "Tell Agent HQ the current job is finished (the office celebrates). Call once, at the end.",
        "inputSchema": _schema({
            "summary": {"type": "string", "description": "One-line result, under 160 characters."},
        }),
    },
    {
        "name": "hq_finding",
        "description": "Report a security finding to Agent HQ's Red Team Lab and VA report room. Only for "
                       "systems the user owns or is authorized in writing to test.",
        "inputSchema": _schema({
            "title": {"type": "string", "description": "e.g. 'SQL injection di /login'. Mentioning ssh, db or "
                                                       "database, api or idor, or admin picks the node on the attack map."},
            "severity": {"type": "string", "enum": SEVERITIES},
            "target": {"type": "string", "description": "Optional host, URL or component."},
        }, ["title"]),
    },
    {
        "name": "hq_alert",
        "description": "Raise a security alert in Agent HQ's SOC room (siren and red lights) for suspicious "
                       "activity you detected, such as brute-force logins.",
        "inputSchema": _schema({
            "message": {"type": "string", "description": "Under 160 characters."},
            "severity": {"type": "string", "enum": SEVERITIES},
            "source_ip": {"type": "string"},
        }, ["message"]),
    },
    {
        "name": "hq_metric",
        "description": "Send the current failed-login count per minute to the SOC chart in Agent HQ.",
        "inputSchema": _schema({
            "value": {"type": "number", "minimum": 0},
            "name": {"type": "string", "description": "Metric name, default failed_logins."},
        }, ["value"]),
    },
]


class ToolError(Exception):
    pass


def text_arg(args, key, n, required=False):
    value = args.get(key)
    text = hq.trunc(hq.redact(value), n) if value is not None else ""
    if required and not text:
        raise ToolError("'%s' is required." % key)
    return text


def choice_arg(args, key, allowed, default):
    value = str(args.get(key) or default).strip().lower()
    if value not in allowed:
        raise ToolError("'%s' must be one of: %s." % (key, ", ".join(allowed)))
    return value


class Reporter:
    def __init__(self, cfg):
        self.cfg = cfg
        self.ppid = str(os.getppid())  # the Hermes process; hq_hook.py runs have the same parent
        self.proj = hq.project_name(os.getcwd())
        seed = "%s:%s:%s" % (socket.gethostname(), self.ppid, cfg["name"])
        self.own_id = "hm-" + hq.short_hash(seed, 8)
        self.own_shown = False  # own character created in Agent HQ

    def target(self):
        """(agent id, linked to the hook character?)"""
        proc = hq.read_state(self.cfg)["procs"].get(self.ppid) or {}
        return (proc["id"], True) if proc.get("id") else (self.own_id, False)

    def identity(self):
        out = {"name": self.cfg["name"] or "%s#%s" % (self.proj, self.own_id[3:7]),
               "role": self.cfg["role"] or "MCP · " + self.proj}
        if self.cfg["team"]:
            out["team"] = self.cfg["team"]
        return out

    def send(self, events):
        status, error = hq.post(self.cfg, "/api/event", events)
        return 200 <= status < 300, error

    def announce(self):
        if self.cfg["announce"] and not self.target()[1]:
            ok, _ = self.send([dict(type="agent_update", id=self.own_id, status="idle",
                                    task="Siap menerima tugas", **self.identity())])
            self.own_shown = self.own_shown or ok

    def goodbye(self):
        if self.own_shown and not self.target()[1]:
            self.send([{"type": "agent_update", "id": self.own_id, "status": "offline", "task": "Sesi selesai"}])

    def call(self, name, args):
        if not isinstance(args, dict):
            args = {}
        agent, linked = self.target()
        events = []
        if name == "hq_status":
            ev = {"type": "agent_update", "id": agent, "status": choice_arg(args, "status", STATUSES, "working")}
            task = text_arg(args, "task", 140)
            if task:
                ev["task"] = task
            if isinstance(args.get("progress"), (int, float)) and not isinstance(args.get("progress"), bool):
                ev["progress"] = max(0.0, min(1.0, float(args["progress"])))
            events.append(ev)
        elif name == "hq_log":
            events.append({"type": "log", "id": agent, "level": choice_arg(args, "level", ["info", "warn", "error"], "info"),
                           "message": text_arg(args, "message", 180, True)})
        elif name == "hq_done":
            summary = text_arg(args, "summary", 170)
            if not linked:  # with hooks, Hermes' own end of turn already celebrates
                events.append({"type": "task_done", "id": agent})
            if summary or linked:
                events.append({"type": "log", "id": agent, "level": "info", "message": "Selesai: " + (summary or "tugas beres")})
        elif name == "hq_finding":
            title = text_arg(args, "title", 120, True)
            target = text_arg(args, "target", 60)
            events.append({"type": "finding", "id": agent, "severity": choice_arg(args, "severity", SEVERITIES, "medium"),
                           "title": "%s (%s)" % (title, target) if target else title})
        elif name == "hq_alert":
            ev = {"type": "alert", "id": agent, "severity": choice_arg(args, "severity", SEVERITIES, "high"),
                  "message": text_arg(args, "message", 160, True)}
            ip = text_arg(args, "source_ip", 45)
            if ip:
                ev["source_ip"] = ip
            events.append(ev)
        elif name == "hq_metric":
            value = args.get("value")
            if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
                raise ToolError("'value' must be a number >= 0.")
            metric = re.sub(r"[^\w.-]", "", str(args.get("name") or "failed_logins"))[:40] or "failed_logins"
            events.append({"type": "metric", "name": metric, "value": value})
        else:
            raise ToolError("Unknown tool: %s" % name)

        if not linked and not self.own_shown and name != "hq_metric":
            first = events[0]
            if first["type"] == "agent_update":
                first.update(self.identity())
            else:
                events.insert(0, dict(type="agent_update", id=agent, status="working", **self.identity()))
        if self.cfg["dry_run"]:
            return "Dry run: %s" % json.dumps(events, ensure_ascii=False)
        ok, error = self.send(events)
        if not ok:
            return "Agent HQ is not reachable at %s (%s). Continue your work; do not retry this report." % (self.cfg["url"], error)
        if not linked:
            self.own_shown = True
        return "Reported to Agent HQ."


def handle(msg, reporter):
    """One JSON-RPC message -> response dict, or None for notifications."""
    if not isinstance(msg, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid request"}}
    method = msg.get("method")
    is_request = "id" in msg
    if not isinstance(method, str):
        return None  # a response to a request we never send
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
    if not is_request:
        if method == "notifications/initialized":
            reporter.announce()
        return None
    if method == "initialize":
        version = params.get("protocolVersion")
        result = {
            "protocolVersion": version if isinstance(version, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", version) else DEFAULT_PROTOCOL,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
            "instructions": INSTRUCTIONS,
        }
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        try:
            text, is_error = reporter.call(params.get("name"), params.get("arguments")), False
        except ToolError as e:
            text, is_error = str(e), True
        except Exception as e:  # report, never crash the server
            text, is_error = "Agent HQ tool failed: %s: %s" % (type(e).__name__, e), True
        result = {"content": [{"type": "text", "text": text}], "isError": is_error}
    else:
        return {"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32601, "message": "Method not found: %s" % method}}
    return {"jsonrpc": "2.0", "id": msg.get("id"), "result": result}


def write(obj):
    sys.stdout.buffer.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def main():
    reporter = Reporter(hq.load_config())
    stdin = sys.stdin.buffer
    while True:
        line = stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line.decode("utf-8"))
        except ValueError:
            write({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
            continue
        if isinstance(msg, list):
            replies = [r for r in (handle(m, reporter) for m in msg) if r is not None]
            if replies:
                write(replies)
        else:
            reply = handle(msg, reporter)
            if reply is not None:
                write(reply)
    try:
        reporter.goodbye()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
