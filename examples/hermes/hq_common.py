"""Shared code for the Agent HQ adapters for Hermes Agent: hq_hook.py (shell hooks) and hq_mcp.py (MCP).

Python 3.8+ standard library only, so it runs on a stock Ubuntu python3.
Settings: environment variables first, then agent-hq.env next to this file, then defaults.

  python3 hq_common.py redact < strings.json   # redact a JSON list of strings (used by the tests)
"""

import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

try:
    import fcntl  # advisory lock; missing on Windows, where locking is skipped
except ImportError:  # pragma: no cover
    fcntl = None

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_TTL = 12 * 3600  # forget sessions and subagents not seen for 12 hours


# ------------------------------------------------------------------ settings

def truthy(value):
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def read_env_file(path):
    """KEY=VALUE lines (optional `export`, quotes, # comments) -> dict. Missing file -> {}."""
    out = {}
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return out
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, sep, val = line.partition("=")
        if not sep:
            continue
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        else:
            val = re.split(r"\s+#", val, maxsplit=1)[0]
        out[key.strip()] = val
    return out


def load_config():
    file_vals = read_env_file(os.environ.get("HQ_ENV_FILE") or os.path.join(HERE, "agent-hq.env"))

    def get(key, default=""):
        return os.environ.get(key) or file_vals.get(key) or default

    url = get("HQ_URL", "http://127.0.0.1:8787").strip().rstrip("/")
    if url.endswith("/api"):
        url = url[:-4]
    try:
        timeout = max(0.2, min(10.0, float(get("HQ_TIMEOUT", "1.5"))))
    except ValueError:
        timeout = 1.5
    cache = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return {
        "url": url,
        "token": get("HQ_TOKEN").strip(),
        "name": get("HQ_NAME").strip(),
        "role": get("HQ_ROLE").strip(),
        "team": get("HQ_TEAM").strip(),
        "timeout": timeout,
        "state_dir": get("HQ_STATE_DIR") or os.path.join(cache, "agent-hq"),
        "disabled": truthy(get("HQ_DISABLE")),
        "dry_run": truthy(get("HQ_DRY_RUN")),
        "announce": truthy(get("HQ_ANNOUNCE")),
    }


# ------------------------------------------------------------------ text

def trunc(value, n):
    """Collapse whitespace, trim, and cut to n chars with an ellipsis (lib/bridge/redact.ts trunc)."""
    t = re.sub(r"\s+", " ", "" if value is None else str(value)).strip()
    return t[: n - 1] + "…" if len(t) > n else t


def _mask_user_pass(v):
    q = v[0] if v[:1] in ("'", '"') else ""
    inner = v[1:-1] if q else v
    i = inner.find(":")
    return v if i < 0 else "%s%s***%s" % (q, inner[: i + 1], q)


# Same patterns as lib/bridge/redact.ts (tests/integration/hermes.test.ts compares them).
# /api/event does not redact, so text the AI sends through MCP is redacted here.
_REDACT = [
    (re.compile(r"(bearer\s+)[\w.\-~+/=]+", re.I), r"\1***"),
    (re.compile(r"((?:api[_-]?key|token|secret|passw(?:or)?d|pwd|authorization)\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|\S+)", re.I), r"\1***"),
    (re.compile(r"(-p\s*)\S+(?=.*\bmysql\b)", re.I), r"\1***"),
    (re.compile(r"\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{10,}\b"), "***"),
    (re.compile(r"(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^|;&\n]*?\s-p)(?!\*\*\*)(\"[^\"]*\"|'[^']*'|\S+)"), r"\1***"),
    (re.compile(r"(\bcurl\b[^|;&\n]*?\s(?:-[uU]\s*|--(?:proxy-)?user(?:\s+|=)))(\"[^\"]*\"|'[^']*'|[^\s\"']+)"),
     lambda m: m.group(1) + _mask_user_pass(m.group(2))),
    (re.compile(r"\b([a-z][a-z0-9+.-]*://)([^\s:@/?#]+):([^\s@/?#]+)@", re.I), r"\1\2:***@"),
    (re.compile(r"(\bsshpass\b[^|;&\n]*?\s-p\s*)(\"[^\"]*\"|'[^']*'|[^\s\"']+)"), r"\1***"),
]


def redact(value):
    """Hide secrets that often show up in commands and prompts."""
    s = "" if value is None else str(value)
    for pattern, repl in _REDACT:
        s = pattern.sub(repl, s)
    return s


def project_name(cwd):
    return os.path.basename(os.path.normpath(str(cwd or ""))) or "hermes"


# ------------------------------------------------------------------ ids

def short_hash(value, n):
    return hashlib.sha1(str(value).encode("utf-8")).hexdigest()[:n]


def hook_session(raw_sid):
    """session_id sent to /api/hook. Hashed because the bridge keys agents on its first 8 chars."""
    return short_hash(raw_sid or "unknown", 16)


def agent_id(raw_sid, sub_key=None):
    """The id the bridge gives a hook agent (hookAgentId in lib/bridge/hooks.ts)."""
    sid = hook_session(raw_sid)
    return "cc-%s-%s" % (sid[:6], short_hash(sub_key, 8)) if sub_key else "cc-" + sid[:8]


# ------------------------------------------------------------------ state

def state_path(cfg):
    return os.path.join(cfg["state_dir"], "hermes-state.json")


def empty_state():
    return {"procs": {}, "sessions": {}, "children": {}, "child_sids": {}, "down_until": 0}


def read_state(cfg):
    data = empty_state()
    try:
        with open(state_path(cfg), encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return data
    if isinstance(raw, dict):
        for key in ("procs", "sessions", "children", "child_sids"):
            if isinstance(raw.get(key), dict):
                data[key] = raw[key]
        if isinstance(raw.get("down_until"), (int, float)):
            data["down_until"] = raw["down_until"]
    return data


def prune(data, now):
    old = now - STATE_TTL
    for key in ("procs", "sessions", "children"):
        data[key] = {k: v for k, v in data[key].items() if isinstance(v, dict) and v.get("at", 0) >= old}
    data["child_sids"] = {s: k for s, k in data["child_sids"].items() if k in data["children"]}


def write_state(cfg, data):
    path = state_path(cfg)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


class State:
    """Locked read-modify-write of the state file shared by hook runs (one process per event) and hq_mcp.py."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.data = None
        self._lock = None

    def __enter__(self):
        os.makedirs(self.cfg["state_dir"], exist_ok=True)
        self._lock = open(state_path(self.cfg) + ".lock", "a")
        if fcntl:
            fcntl.flock(self._lock.fileno(), fcntl.LOCK_EX)
        self.data = read_state(self.cfg)
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                prune(self.data, time.time())
                write_state(self.cfg, self.data)
        finally:
            if fcntl:
                fcntl.flock(self._lock.fileno(), fcntl.LOCK_UN)
            self._lock.close()
        return False


# ------------------------------------------------------------------ http

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never route the bridge through a proxy


def _header_value(value):
    """http.client only sends latin-1 header values; anything else is dropped."""
    try:
        value.encode("latin-1")
        return value
    except UnicodeEncodeError:
        return ""


def request(cfg, method, path, body=None, headers=None):
    """Call Agent HQ. Returns (status, error): status 0 means not reachable, 2xx means ok."""
    h = {"Content-Type": "application/json"} if body is not None else {}
    if cfg["token"]:
        h["Authorization"] = "Bearer " + cfg["token"]
    for key, value in (headers or {}).items():
        value = _header_value(value or "")
        if value:
            h[key] = value
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(cfg["url"] + path, data=data, headers=h, method=method)
    try:
        with _OPENER.open(req, timeout=cfg["timeout"]) as res:
            res.read()
            return res.status, ""
    except urllib.error.HTTPError as e:
        return e.code, "HTTP %d%s" % (e.code, " (HQ_TOKEN salah?)" if e.code == 401 else "")
    except (urllib.error.URLError, OSError, ValueError) as e:
        return 0, str(getattr(e, "reason", e))


def post(cfg, path, body, headers=None):
    return request(cfg, "POST", path, body, headers)


def main(argv):
    if argv[:1] == ["redact"]:
        sys.stdout.write(json.dumps([redact(s) for s in json.load(sys.stdin)], ensure_ascii=False))
        return 0
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
