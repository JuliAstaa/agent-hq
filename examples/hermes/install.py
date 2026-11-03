#!/usr/bin/env python3
"""Install the Agent HQ adapters into Hermes Agent (Ubuntu VPS, other Linux, macOS).

  python3 examples/hermes/install.py                   # hooks + MCP
  python3 examples/hermes/install.py --no-mcp          # hooks only
  python3 examples/hermes/install.py --no-hooks        # MCP only
  python3 examples/hermes/install.py --url URL         # Agent HQ address (default http://127.0.0.1:8787)
  python3 examples/hermes/install.py --print           # copy files, show the config.yaml blocks, edit nothing
  python3 examples/hermes/install.py --no-cron         # no schedule reporter (PAPAN JADWAL stays hidden)
  python3 examples/hermes/install.py --no-service      # copy hq_cron.py but do not set up its systemd service

Copies hq_common.py, hq_hook.py, hq_mcp.py and hq_cron.py to $HERMES_HOME/agent-hq (default ~/.hermes/agent-hq),
creates agent-hq.env there if missing, then adds the hooks and the MCP server to $HERMES_HOME/config.yaml
after saving a backup, and starts the schedule reporter as the systemd user service agent-hq-cron.
Running it again is safe: blocks that are already there are left alone, the reporter restarts with the new code.
"""

import argparse
import datetime
import json
import os
import re
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
    ap.add_argument("--hermes-home", default=os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes"))
    args = ap.parse_args(argv)
    if args.no_hooks and args.no_mcp:
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

    ok, detail = health(url)
    if ok:
        print("\n  koneksi    : OK, Agent HQ menjawab di %s" % url)
    else:
        print("\n  koneksi    : GAGAL ke %s (%s)" % (url, detail))
        print("               Jalankan Agent HQ di VPS ini (docs/hermes.md bagian 3),")
        print("               atau buka tunnel ke Agent HQ di laptop (bagian 5).")

    print("\nLangkah berikutnya:")
    print("  1. Jalankan hermes. Kalau ditanya izin untuk hook hq_hook.py, jawab ya (disimpan, cukup sekali).")
    print("     Gateway tidak pernah bertanya: izinkan dulu lewat hermes, lalu: hermes gateway restart")
    print("  2. Cek: hermes hooks list   dan   hermes mcp test %s" % SERVER)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
