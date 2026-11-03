#!/usr/bin/env python3
"""Install the Agent HQ adapters into Hermes Agent (Ubuntu VPS, other Linux, macOS).

  python3 examples/hermes/install.py                   # hooks + MCP
  python3 examples/hermes/install.py --no-mcp          # hooks only
  python3 examples/hermes/install.py --no-hooks        # MCP only
  python3 examples/hermes/install.py --url URL         # Agent HQ address (default http://127.0.0.1:8787)
  python3 examples/hermes/install.py --print           # copy files, show the config.yaml blocks, edit nothing
  python3 examples/hermes/install.py --no-cron         # no schedule reporter (PAPAN JADWAL stays hidden)
  python3 examples/hermes/install.py --no-service      # copy hq_cron.py but do not set up its systemd service
  python3 examples/hermes/install.py --chat            # also turn on Hermes' API server for the chat panel

Copies hq_common.py, hq_hook.py, hq_mcp.py and hq_cron.py to $HERMES_HOME/agent-hq (default ~/.hermes/agent-hq),
creates agent-hq.env there if missing, then adds the hooks and the MCP server to $HERMES_HOME/config.yaml
after saving a backup, and starts the schedule reporter as the systemd user service agent-hq-cron.
With --chat it also sets API_SERVER_ENABLED and API_SERVER_KEY in $HERMES_HOME/.env (backup first, an existing
key is kept) and writes HQ_HERMES_API_URL / HQ_HERMES_API_KEY to .env.local of this Agent HQ checkout.
Running it again is safe: blocks that are already there are left alone, the reporter restarts with the new code.
"""

import argparse
import datetime
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = ["hq_common.py", "hq_hook.py", "hq_mcp.py", "hq_cron.py"]
CRON_UNIT = "agent-hq-cron.service"
EVENTS = [
    "on_session_start", "pre_llm_call", "pre_tool_call", "post_tool_call", "post_llm_call",
    "on_session_end", "on_session_finalize", "subagent_start", "subagent_stop",
    "pre_approval_request", "post_approval_response", "on_human_input_request", "on_human_input_resolved",
]
SERVER = "agent_hq"
HOOK_TIMEOUT = 5
EMPTY = ("", "{}", "null", "~")


# ------------------------------------------------------------------ files

def copy_files(dest):
    os.makedirs(dest, exist_ok=True)
    for name in FILES:
        with open(os.path.join(HERE, name), encoding="utf-8") as f:
            text = f.read().replace("\r\n", "\n")  # a Windows checkout may have CRLF
        target = os.path.join(dest, name)
        with open(target, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.chmod(target, 0o644 if name == "hq_common.py" else 0o755)


def write_env(dest, url):
    """Create agent-hq.env from the example, or update HQ_URL in an existing one when --url is given."""
    path = os.path.join(dest, "agent-hq.env")
    if not os.path.exists(path):
        with open(os.path.join(HERE, "agent-hq.env.example"), encoding="utf-8") as f:
            text = f.read().replace("\r\n", "\n")
        if url:
            text = re.sub(r"(?m)^HQ_URL=.*$", "HQ_URL=" + url, text)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.chmod(path, 0o600)  # may hold HQ_TOKEN
        return path, "dibuat"
    if url:
        with open(path, encoding="utf-8") as f:
            text = f.read()
        if re.search(r"(?m)^HQ_URL=", text):
            text = re.sub(r"(?m)^HQ_URL=.*$", "HQ_URL=" + url, text)
        else:
            text = "HQ_URL=%s\n%s" % (url, text)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        return path, "HQ_URL diperbarui"
    return path, "sudah ada, tidak diubah"


def env_url(path):
    try:
        with open(path, encoding="utf-8") as f:
            m = re.search(r"(?m)^HQ_URL=(.*)$", f.read())
        return m.group(1).strip().strip("\"'") if m else "http://127.0.0.1:8787"
    except OSError:
        return "http://127.0.0.1:8787"


# ------------------------------------------------------------------ config.yaml

def present(value, text):
    """value already in config.yaml, raw or as written inside a YAML double-quoted string."""
    return value in text or json.dumps(value)[1:-1] in text


def hook_lines(ind, cmd, events):
    out = []
    for ev in events:
        out += ["%s%s:" % (ind, ev), "%s  - command: %s" % (ind, json.dumps(cmd)), "%s    timeout: %d" % (ind, HOOK_TIMEOUT)]
    return out


def mcp_lines(ind, python, script):
    return ["%s%s:" % (ind, SERVER), "%s  command: %s" % (ind, json.dumps(python)),
            "%s  args: [%s]" % (ind, json.dumps(script)), "%s  timeout: 15" % ind, "%s  connect_timeout: 15" % ind]


def locate(lines, key):
    """Top-level `key:` -> (line index, inline value, end index of its block, child lines, sequence?) or None."""
    pat = re.compile(r"^%s\s*:(.*)$" % re.escape(key))
    for i, line in enumerate(lines):
        m = pat.match(line)
        if not m:
            continue
        value = re.split(r"(^|\s)#", m.group(1), maxsplit=1)[0].strip()
        end, j = i + 1, i + 1
        while j < len(lines):
            s = lines[j]
            if not s.strip() or s.lstrip().startswith("#"):
                j += 1
            elif s[0] in " \t":
                end, j = j + 1, j + 1
            else:
                break
        children = [s for s in lines[i + 1:end] if s.strip() and not s.lstrip().startswith("#")]
        sequence = j < len(lines) and lines[j].startswith("-") and not children
        return i, value, end, children, sequence
    return None


def add_children(lines, key, child_lines_for, taken_names):
    """Add children under a top-level mapping key. Returns (lines, added: bool, reason)."""
    loc = locate(lines, key)
    if loc is None:
        tail = [""] if lines and lines[-1].strip() else []
        return lines + tail + ["%s:" % key] + child_lines_for("  ", set()), True, ""
    i, value, end, children, sequence = loc
    if value not in EMPTY or sequence:
        return lines, False, "`%s:` ditulis dalam format yang tidak bisa diubah otomatis" % key
    if not children:
        return lines[:i] + ["%s:" % key] + child_lines_for("  ", set()) + lines[i + 1:], True, ""
    ind = re.match(r"^[ \t]*", children[0]).group(0)
    if "\t" in ind:
        return lines, False, "`%s:` memakai tab" % key
    names = set()
    for s in children:
        m = re.match(r"^%s([A-Za-z_][\w-]*)\s*:" % re.escape(ind), s)
        if m:
            names.add(m.group(1))
    new = child_lines_for(ind, names)
    if not new:
        return lines, False, "sudah ada entri %s di `%s:`" % (", ".join(sorted(taken_names & names)), key)
    return lines[:end] + new + lines[end:], True, ""


def yaml_loader():
    """A YAML parser for checking the result: PyYAML here, or Hermes' own Python (which has it)."""
    try:
        import yaml  # noqa: F401
        return lambda text: yaml.safe_load(text)
    except ImportError:
        pass
    exe = shutil.which("hermes")
    if not exe:
        return None
    try:
        with open(os.path.realpath(exe), "rb") as f:
            line = f.readline().decode("utf-8", "replace").strip()
    except OSError:
        return None
    py = line[2:].strip().split(" ")[0] if line.startswith("#!") else ""
    if not py or os.path.basename(py) == "env" or not os.path.exists(py):
        return None
    code = "import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read()), default=str))"

    def load(text):
        res = subprocess.run([py, "-c", code], input=text, capture_output=True, text=True, timeout=30)
        if res.returncode != 0:
            raise ValueError(res.stderr.strip().splitlines()[-1] if res.stderr.strip() else "YAML tidak valid")
        return json.loads(res.stdout)
    return load


def check_result(load, old_text, new_text, hook_cmd, hook_events, python, mcp_script):
    """Parse the new config and make sure our blocks landed and nothing else disappeared."""
    old = load(old_text) or {}
    new = load(new_text) or {}
    if not isinstance(new, dict):
        raise ValueError("config.yaml bukan mapping")
    missing = [k for k in (old if isinstance(old, dict) else {}) if k not in new]
    if missing:
        raise ValueError("kunci hilang: %s" % ", ".join(missing))
    for ev in hook_events:
        entries = (new.get("hooks") or {}).get(ev) or []
        if not any(isinstance(e, dict) and e.get("command") == hook_cmd for e in entries):
            raise ValueError("hook %s tidak terbaca" % ev)
    if mcp_script:
        server = (new.get("mcp_servers") or {}).get(SERVER) or {}
        if server.get("args") != [mcp_script] or server.get("command") != python:
            raise ValueError("mcp_servers.%s tidak terbaca" % SERVER)


# ------------------------------------------------------------------ chat (Hermes API server)

ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


def read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def env_values(text):
    """KEY=value lines of a .env file (quotes around the value removed)."""
    out = {}
    for line in text.splitlines():
        m = ENV_LINE.match(line)
        if m and not line.lstrip().startswith("#"):
            v = m.group(2)
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            out[m.group(1)] = v
    return out


def set_env(text, values, comment):
    """Replace KEY= lines in place, append the missing ones under a comment. Keeps every other line."""
    lines = text.splitlines()
    missing = dict(values)
    for i, line in enumerate(lines):
        m = ENV_LINE.match(line)
        if m and not line.lstrip().startswith("#") and m.group(1) in missing:
            lines[i] = "%s=%s" % (m.group(1), missing.pop(m.group(1)))
    if missing:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(comment)
        lines += ["%s=%s" % kv for kv in missing.items()]
    return "\n".join(lines) + "\n"


def write_private(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.chmod(path, 0o600)


def agent_hq_root(path):
    """The Agent HQ checkout: has package.json named agent-hq."""
    return path if '"name": "agent-hq"' in read_text(os.path.join(path, "package.json")) else ""


def setup_chat(home, hq_dir, print_only):
    """Turn on Hermes' API server and point Agent HQ's chat panel at it. Returns summary lines and next steps."""
    hermes_env = os.path.join(home, ".env")
    text = read_text(hermes_env)
    vals = env_values(text)
    changes = {}
    if vals.get("API_SERVER_ENABLED", "").lower() not in ("true", "1", "yes", "on"):
        changes["API_SERVER_ENABLED"] = "true"
    key = vals.get("API_SERVER_KEY", "")
    if len(key) < 16:  # Hermes refuses to start the API server with a short key
        key = secrets.token_hex(32)
        changes["API_SERVER_KEY"] = key
    host = vals.get("API_SERVER_HOST", "") or "127.0.0.1"
    port = vals.get("API_SERVER_PORT", "") or "8642"
    url = "http://%s:%s" % ("127.0.0.1" if host in ("0.0.0.0", "::", "") else ("[::1]" if host == "::1" else host), port)
    lines, steps = [], []
    if host not in LOOPBACK_HOSTS:
        lines.append("  PERINGATAN : API_SERVER_HOST=%s membuka API Hermes ke jaringan. Untuk Agent HQ cukup 127.0.0.1." % host)
    root = agent_hq_root(hq_dir) if hq_dir else ""
    local = os.path.join(root, ".env.local") if root else ""
    if print_only:
        lines.append("  chat       : akan mengisi %s (%s)" % (hermes_env, ", ".join(sorted(changes)) or "sudah aktif"))
        lines.append("               dan %s (HQ_HERMES_API_URL=%s, HQ_HERMES_API_KEY)" % (local or "<folder Agent HQ>/.env.local", url))
        return lines, steps
    if changes:
        if text:
            backup = "%s.agent-hq-%s.bak" % (hermes_env, datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
            shutil.copy2(hermes_env, backup)
            os.chmod(backup, 0o600)
        write_private(hermes_env, set_env(text, changes, "# Agent HQ: chat Hermes (docs/hermes.md, Chat Hermes)"))
        lines.append("  chat       : %s diisi (%s)" % (hermes_env, ", ".join(sorted(changes))))
        steps.append("hermes gateway restart        (API server Hermes mulai di %s)" % url)
    else:
        lines.append("  chat       : API server Hermes sudah aktif di %s" % hermes_env)
    if not root:
        lines.append("  chat       : folder Agent HQ tidak ditemukan. Isi sendiri di .env.local Agent HQ:")
        lines.append("               HQ_HERMES_API_URL=%s" % url)
        lines.append("               HQ_HERMES_API_KEY=<sama dengan API_SERVER_KEY di %s>" % hermes_env)
        return lines, steps
    old = read_text(local)
    want = {"HQ_HERMES_API_URL": url, "HQ_HERMES_API_KEY": key}
    if any(env_values(old).get(k) != v for k, v in want.items()):
        write_private(local, set_env(old, want, "# Hermes chat panel (docs/hermes.md, Chat Hermes)"))
        lines.append("  chat       : %s diisi (HQ_HERMES_API_URL=%s, HQ_HERMES_API_KEY)" % (local, url))
        steps.append("pm2 restart agent-hq          (atau ./start.sh di %s) agar Agent HQ membaca .env.local" % root)
    else:
        lines.append("  chat       : %s sudah cocok" % local)
    return lines, steps


# ------------------------------------------------------------------ main

def cron_unit(python, script, hermes_home, hermes_bin):
    """systemd user unit for the schedule reporter (next to Hermes' own hermes-gateway user service)."""
    env = ['Environment="HERMES_HOME=%s"' % hermes_home]
    if hermes_bin:
        env.append('Environment="HQ_HERMES_BIN=%s"' % hermes_bin)  # services do not get ~/.local/bin in PATH
    return "\n".join([
        "[Unit]",
        "Description=Agent HQ: jadwal cron Hermes ke PAPAN JADWAL",
        "After=network-online.target",
        "",
        "[Service]",
        'ExecStart="%s" "%s"' % (python, script),
        *env,
        "Restart=on-failure",  # a clean exit (HQ_DISABLE, stop) stays stopped; a crash restarts
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ])


def install_cron_service(unit_text):
    """Write and (re)start the user service. Returns a one-line status for the summary."""
    if not shutil.which("systemctl"):
        return "systemctl tidak ada: jalankan python3 hq_cron.py sendiri (docs/hermes.md, Jadwal)"
    unit_dir = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "systemd", "user")
    os.makedirs(unit_dir, exist_ok=True)
    with open(os.path.join(unit_dir, CRON_UNIT), "w", encoding="utf-8", newline="\n") as f:
        f.write(unit_text)
    for cmd in (["daemon-reload"], ["enable", CRON_UNIT], ["restart", CRON_UNIT]):
        r = subprocess.run(["systemctl", "--user"] + cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        if r.returncode != 0:
            err = (r.stderr or r.stdout).strip().splitlines()
            return "GAGAL systemctl --user %s: %s" % (" ".join(cmd), err[-1] if err else r.returncode)
    note = ""
    user = os.environ.get("USER") or ""
    if shutil.which("loginctl") and user:
        r = subprocess.run(["loginctl", "show-user", user, "-p", "Linger"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True)
        if r.stdout.strip() == "Linger=no":
            note = "; jalankan: sudo loginctl enable-linger %s (agar tetap jalan setelah logout)" % user
    return "service %s jalan%s" % (CRON_UNIT, note)


def health(url):
    req = urllib.request.Request(url.rstrip("/") + "/api/health")
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=2) as res:
            return True, res.read().decode("utf-8", "replace")[:120]
    except Exception as e:
        return False, str(getattr(e, "reason", e))


def main(argv):
    ap = argparse.ArgumentParser(description="Pasang Agent HQ ke Hermes Agent.")
    ap.add_argument("--no-hooks", action="store_true", help="jangan pasang hook")
    ap.add_argument("--no-mcp", action="store_true", help="jangan pasang server MCP")
    ap.add_argument("--url", help="alamat Agent HQ, misalnya http://127.0.0.1:8787")
    ap.add_argument("--print", dest="print_only", action="store_true", help="tampilkan blok config.yaml saja")
    ap.add_argument("--no-cron", action="store_true", help="jangan pasang reporter jadwal (hq_cron.py)")
    ap.add_argument("--no-service", action="store_true", help="salin hq_cron.py tanpa memasang service systemd")
    ap.add_argument("--chat", action="store_true", help="aktifkan API server Hermes untuk panel chat Agent HQ")
    ap.add_argument("--agent-hq-dir", default=os.path.dirname(os.path.dirname(HERE)),
                    help="folder Agent HQ untuk .env.local (default: folder repo ini)")
    ap.add_argument("--hermes-home", default=os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes"))
    args = ap.parse_args(argv)
    if args.no_hooks and args.no_mcp and not args.chat:
        ap.error("--no-hooks dan --no-mcp sekaligus: tidak ada yang dipasang")

    home = os.path.abspath(args.hermes_home)
    if not os.path.isdir(home):
        print("Folder Hermes %s tidak ada. Pasang Hermes dulu (docs/hermes.md bagian 2)," % home)
        print("atau tunjuk folder lain dengan --hermes-home.")
        return 1
    dest = os.path.join(home, "agent-hq")
    copy_files(dest)
    env_path, env_state = write_env(dest, args.url)
    url = args.url or env_url(env_path)

    python = shutil.which("python3") or sys.executable
    hook_cmd = " ".join(shlex.quote(a) for a in (python, os.path.join(dest, "hq_hook.py")))
    mcp_script = os.path.join(dest, "hq_mcp.py")
    want_hooks, want_mcp = not args.no_hooks, not args.no_mcp

    print("Agent HQ untuk Hermes")
    print("  file       : %s (%s)" % (dest, ", ".join(FILES)))
    print("  pengaturan : %s (%s)" % (env_path, env_state))

    blocks = []
    if want_hooks:
        blocks += ["hooks:"] + hook_lines("  ", hook_cmd, EVENTS)
    if want_mcp:
        blocks += ["mcp_servers:"] + mcp_lines("  ", python, mcp_script)

    config = os.path.join(home, "config.yaml")
    manual = []
    if args.print_only:
        print("\nTambahkan ke %s (gabungkan kalau kuncinya sudah ada):\n" % config)
        print("\n".join(blocks))
    else:
        old_text = ""
        if os.path.exists(config):
            with open(config, encoding="utf-8") as f:
                old_text = f.read()
        lines = old_text.splitlines()
        added_events, mcp_added = [], False
        if want_hooks:
            if present(hook_cmd, old_text):
                print("  hook       : sudah terpasang")
            else:
                def hooks_for(ind, taken):
                    added_events[:] = [e for e in EVENTS if e not in taken]
                    return hook_lines(ind, hook_cmd, added_events)
                lines, ok, reason = add_children(lines, "hooks", hooks_for, set(EVENTS))
                skipped = [e for e in EVENTS if e not in added_events] if ok else EVENTS
                if not ok:
                    added_events = []
                if skipped:
                    manual += ["hooks:"] + hook_lines("  ", hook_cmd, skipped)
                    print("  hook       : %d event ditambahkan, %d perlu digabung manual (%s)"
                          % (len(added_events), len(skipped), reason or "event sudah punya hook lain"))
                else:
                    print("  hook       : %d event ditambahkan" % len(added_events))
        if want_mcp:
            if present(mcp_script, old_text):
                print("  MCP        : sudah terpasang")
            else:
                def mcp_for(ind, taken):
                    return [] if SERVER in taken else mcp_lines(ind, python, mcp_script)
                lines, mcp_added, reason = add_children(lines, "mcp_servers", mcp_for, {SERVER})
                if mcp_added:
                    print("  MCP        : server %s ditambahkan" % SERVER)
                else:
                    manual += ["mcp_servers:"] + mcp_lines("  ", python, mcp_script)
                    print("  MCP        : perlu digabung manual (%s)" % reason)

        new_text = "\n".join(lines) + "\n"
        if added_events or mcp_added:
            load = yaml_loader()
            if load:
                try:
                    check_result(load, old_text, new_text, hook_cmd, added_events, python,
                                 mcp_script if mcp_added else None)
                except Exception as e:
                    print("\nconfig.yaml TIDAK diubah: hasil gabungan gagal dicek (%s)." % e)
                    print("Tambahkan blok di bawah secara manual.\n")
                    print("\n".join(blocks))
                    return 1
            else:
                print("  cek YAML   : dilewati (PyYAML tidak ada)")
            backup = ""
            if old_text:
                backup = "%s.agent-hq-%s.bak" % (config, datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
                shutil.copy2(config, backup)
            with open(config, "w", encoding="utf-8", newline="\n") as f:
                f.write(new_text)
            print("  config     : %s%s" % (config, " (cadangan: %s)" % os.path.basename(backup) if backup else " (dibuat)"))
        if manual:
            print("\nGabungkan ini ke %s secara manual:\n" % config)
            print("\n".join(manual))

    if not args.no_cron:
        script = os.path.join(dest, "hq_cron.py")
        if args.no_service or args.print_only:
            print("\n  jadwal     : jalankan sendiri: %s %s" % (python, script))
        else:
            print("\n  jadwal     : " + install_cron_service(cron_unit(python, script, home, shutil.which("hermes") or "")))

    chat_steps = []
    if args.chat:
        chat_lines, chat_steps = setup_chat(home, os.path.abspath(args.agent_hq_dir), args.print_only)
        print("\n" + "\n".join(chat_lines))

    ok, detail = health(url)
    if ok:
        print("\n  koneksi    : OK, Agent HQ menjawab di %s" % url)
    else:
        print("\n  koneksi    : GAGAL ke %s (%s)" % (url, detail))
        print("               Jalankan Agent HQ di VPS ini (docs/hermes.md bagian 3),")
        print("               atau buka tunnel ke Agent HQ di laptop (bagian 5).")

    print("\nLangkah berikutnya:")
    n = 1
    if not args.no_hooks:
        print("  %d. Jalankan hermes. Kalau ditanya izin untuk hook hq_hook.py, jawab ya (disimpan, cukup sekali)." % n)
        print("     Gateway tidak pernah bertanya: izinkan dulu lewat hermes, lalu: hermes gateway restart")
        n += 1
    if not (args.no_hooks and args.no_mcp):
        print("  %d. Cek: hermes hooks list   dan   hermes mcp test %s" % (n, SERVER))
        n += 1
    for step in chat_steps:
        print("  %d. %s" % (n, step))
        n += 1
    if args.chat and not args.print_only:
        print("  %d. Buka Agent HQ lewat tunnel (localhost), lalu tombol Hermes di kanan atas." % n)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
