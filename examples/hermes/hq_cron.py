#!/usr/bin/env python3
"""Agent HQ schedule reporter for Hermes cron (docs/hermes.md "Jadwal").

Runs next to Hermes as the Hermes user (systemd user service `agent-hq-cron`, set up by install.py). It
  - reads $HERMES_HOME/cron/jobs.json, executions.db and the ticker heartbeat, and posts a {"type": "schedule"}
    snapshot to Agent HQ when something changes, and every 30 s as a heartbeat;
  - long-polls Agent HQ for commands from the office's schedule panel and runs them as
    `hermes cron run|pause|resume <job_id>` (argument list, no shell), then reports the result.
Job prompts are never sent; names and errors are redacted. Python 3.8+ standard library only.

  python3 hq_cron.py           # run until stopped (SIGTERM or Ctrl+C)
  python3 hq_cron.py --once    # print one snapshot as JSON and exit (no network)

Settings (agent-hq.env or env): HQ_URL, HQ_TOKEN, HQ_HERMES_BIN (path to `hermes`), HERMES_HOME,
HQ_CRON_CONTROLS ("run,pause,resume" by default; "none" = view only), HQ_CRON_SOURCE (label on the board).
"""

import datetime
import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time

import hq_common as hq

ACTIONS = ("run", "pause", "resume")
JOB_ID = re.compile(r"^[\w.-]{1,64}$")
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
SCAN_EVERY = 5  # seconds between looks at jobs.json
HEARTBEAT = 30  # seconds: post the snapshot at least this often
TICKER_DEAD = 180  # seconds without a ticker heartbeat = scheduler not running
RUN_STALE = 15 * 60  # a claimed/running execution without progress for this long is not running any more


def log(msg):
    sys.stderr.write("%s agent-hq-cron: %s\n" % (time.strftime("%H:%M:%S"), msg))
    sys.stderr.flush()


def settings():
    cfg = hq.load_config()
    env = hq.read_env_file(os.environ.get("HQ_ENV_FILE") or os.path.join(hq.HERE, "agent-hq.env"))

    def get(key, default=""):
        return os.environ.get(key) or env.get(key) or default

    home = os.path.expanduser(get("HERMES_HOME", "~/.hermes"))
    raw = get("HQ_CRON_CONTROLS", ",".join(ACTIONS)).strip().lower()
    cfg["controls"] = [] if raw in ("none", "off", "0") else [a for a in re.split(r"[\s,]+", raw) if a in ACTIONS]
    cfg["cron_dir"] = os.path.join(home, "cron")
    cfg["hermes_home"] = home
    cfg["hermes_bin"] = get("HQ_HERMES_BIN") or shutil.which("hermes") or os.path.expanduser("~/.local/bin/hermes")
    cfg["source"] = hq.trunc(get("HQ_CRON_SOURCE") or "Hermes di %s" % socket.gethostname(), 40)
    return cfg


# ------------------------------------------------------------------ reading Hermes

def epoch_ms(value):
    """ISO string (Hermes writes these) or epoch -> epoch ms. A naive time is the server's local time."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value * 1000 if value < 1e12 else value)
    try:
        d = datetime.datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.astimezone()
    return int(d.timestamp() * 1000)


def running_jobs(cron_dir, now):
    """Job ids with a claimed or running execution that showed progress recently."""
    path = os.path.join(cron_dir, "executions.db")
    if not os.path.exists(path):
        return set()
    try:
        con = sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=1)
        try:
            rows = con.execute("SELECT job_id, claimed_at, progress_at FROM executions WHERE status IN ('claimed', 'running')").fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return set()
    out = set()
    for job_id, claimed, progress in rows:
        seen = max([t for t in (epoch_ms(claimed), epoch_ms(progress)) if t is not None] or [0]) / 1000.0
        if now - seen < RUN_STALE:
            out.add(str(job_id))
    return out


def scheduler_alive(cron_dir, now):
    try:
        return now - os.stat(os.path.join(cron_dir, "ticker_heartbeat")).st_mtime < TICKER_DEAD
    except OSError:
        return False


def job_view(j, running):
    """One job as Agent HQ sees it: no prompt, no chat ids, redacted name and error."""
    jid = str(j.get("id") or "")
    if not JOB_ID.match(jid):
        return None
    shown = hq.schedule_text(j)
    status = str(j.get("last_status") or "").lower()
    failed = status in ("error", "failed", "failure")
    enabled = j.get("enabled", True) is not False
    deliver = ",".join(p.split(":")[0].strip() for p in str(j.get("deliver") or "").split(",") if p.strip())
    return {
        "id": jid,
        "name": hq.trunc(hq.redact(j.get("name") or jid), 60),
        "schedule": hq.trunc(shown, 40),
        "next_run_at": epoch_ms(j.get("next_run_at")),
        "last_run_at": epoch_ms(j.get("last_run_at")),
        "last_status": "error" if failed else ("ok" if status or j.get("last_run_at") else None),
        "last_error": hq.trunc(hq.redact(j.get("last_error") or ""), 200) if failed else "",
        "state": hq.trunc(j.get("state") or ("scheduled" if enabled else "paused"), 20),
        "enabled": enabled,
        "running": jid in running,
        "failure_streak": int(j.get("failure_streak") or 0) if str(j.get("failure_streak") or "0").isdigit() else 0,
        "deliver": hq.trunc(deliver, 30),
    }


def snapshot(cfg, now=None):
    now = time.time() if now is None else now
    running = running_jobs(cfg["cron_dir"], now)
    jobs = [v for v in (job_view(j, running) for j in hq.load_cron_jobs(cfg["cron_dir"])) if v]
    return {
        "type": "schedule",
        "source": cfg["source"],
        "controls": cfg["controls"],
        "scheduler": {"alive": scheduler_alive(cfg["cron_dir"], now)},
        "jobs": jobs[:50],
    }


# ------------------------------------------------------------------ running commands

def hermes_argv(cfg):
    b = cfg["hermes_bin"]
    return [sys.executable, b] if b.endswith(".py") else [b]  # .py: test double


def run_command(cfg, cmd, known_ids):
    """Check a command again and run it. Returns (ok, message)."""
    action, job = cmd.get("action"), str(cmd.get("job") or "")
    if action not in cfg["controls"]:
        return False, "aksi ini dimatikan di reporter (HQ_CRON_CONTROLS)"
    if not JOB_ID.match(job) or job not in known_ids:
        return False, "jadwal tidak ada di Hermes"
    argv = hermes_argv(cfg) + ["cron", action, job]
    env = dict(os.environ, HERMES_HOME=cfg["hermes_home"], NO_COLOR="1")
    try:
        p = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, timeout=60, env=env)
    except FileNotFoundError:
        return False, "perintah hermes tidak ditemukan, atur HQ_HERMES_BIN"
    except subprocess.TimeoutExpired:
        return False, "hermes cron tidak selesai dalam 60 detik"
    lines = [ANSI.sub("", ln).strip() for ln in ((p.stdout or "") + "\n" + (p.stderr or "")).splitlines()]
    lines = [ln for ln in lines if ln]
    message = lines[-1] if lines else ""
    if p.returncode == 0 and action == "run":
        message = "jalan di tick berikutnya (maks 1 menit)"
    return p.returncode == 0, hq.trunc(hq.redact(message), 160)


# ------------------------------------------------------------------ loops

class Reporter:
    def __init__(self, cfg):
        self.cfg = cfg
        self.stop = threading.Event()
        self.rescan = threading.Event()
        self.known = set()
        self.last_sent = None
        self.last_at = 0.0

    def report_loop(self):
        wait = SCAN_EVERY
        while not self.stop.is_set():
            snap = snapshot(self.cfg)
            self.known = {j["id"] for j in snap["jobs"]}
            body = json.dumps(snap, sort_keys=True)
            if body != self.last_sent or time.time() - self.last_at >= HEARTBEAT:
                status, error = hq.post(self.cfg, "/api/event", snap)
                if 200 <= status < 300:
                    if self.last_sent is None:
                        log("tersambung ke %s, %d jadwal" % (self.cfg["url"], len(snap["jobs"])))
                    self.last_sent, self.last_at, wait = body, time.time(), SCAN_EVERY
                else:
                    log("gagal kirim jadwal: %s" % (error or status))
                    self.last_sent, wait = None, min(30, wait * 2)
            self.rescan.wait(wait)
            self.rescan.clear()

    def command_loop(self):
        while not self.stop.is_set():
            if not self.cfg["controls"]:
                self.stop.wait(60)
                continue
            status, error, data = hq.get_json(self.cfg, "/api/cron/commands?wait=20", timeout=30)
            if status != 200:
                if status == 401:
                    log("ditolak Agent HQ: %s" % error)
                self.stop.wait(30 if status == 401 else 5)
                continue
            for cmd in (data or {}).get("commands") or []:
                if not isinstance(cmd, dict):
                    continue
                self.known = {j["id"] for j in snapshot(self.cfg)["jobs"]}
                ok, message = run_command(self.cfg, cmd, self.known)
                log("%s %s %s: %s" % (cmd.get("action"), cmd.get("job"), "ok" if ok else "gagal", message))
                hq.post(self.cfg, "/api/cron/result", {"id": cmd.get("id"), "ok": ok, "message": message})
                self.rescan.set()  # show the new state right away

    def goodbye(self):
        snap = snapshot(self.cfg)
        snap["offline"] = True
        hq.post(self.cfg, "/api/event", snap)


def main(argv):
    cfg = settings()
    if "--once" in argv:
        sys.stdout.write(json.dumps(snapshot(cfg), ensure_ascii=False, indent=2) + "\n")
        return 0
    if cfg["disabled"]:
        log("HQ_DISABLE aktif, berhenti. Hapus HQ_DISABLE lalu: systemctl --user restart agent-hq-cron")
        return 0
    r = Reporter(cfg)

    def stop(*_):
        r.stop.set()
        r.rescan.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    log("membaca %s, kontrol: %s" % (cfg["cron_dir"], ",".join(cfg["controls"]) or "lihat saja"))
    threads = [threading.Thread(target=r.report_loop, daemon=True), threading.Thread(target=r.command_loop, daemon=True)]
    for t in threads:
        t.start()
    while not r.stop.is_set():
        r.stop.wait(1)
    r.goodbye()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
