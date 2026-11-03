#!/usr/bin/env bash
# Web terminal for the Terminal button in Agent HQ (docs/terminal.md). Runs ttyd on 127.0.0.1 only, with a password,
# and refuses WebSocket connections from other sites. The shell runs in the tmux session "agent-hq" when tmux is
# installed, so commands keep running when the panel is closed and every viewer sees the same session.
#
# Run as a normal user (not root), from the repo folder:
#   pm2 start examples/terminal/ttyd.sh --name agent-hq-terminal && pm2 save
#
# Optional env: HQ_TERMINAL_PORT (default 7681), HQ_TERMINAL_CRED_FILE (default ~/.config/agent-hq/terminal.cred).

set -euo pipefail

PORT=${HQ_TERMINAL_PORT:-7681}
CRED_FILE=${HQ_TERMINAL_CRED_FILE:-$HOME/.config/agent-hq/terminal.cred}

if [ "$(id -u)" = 0 ]; then
  echo "Jangan jalankan terminal web sebagai root. Pakai user biasa." >&2
  exit 1
fi
if ! [[ $PORT =~ ^[0-9]+$ ]]; then
  echo "HQ_TERMINAL_PORT harus angka, bukan \"$PORT\"." >&2
  exit 1
fi
if ! command -v ttyd >/dev/null 2>&1; then
  echo "ttyd tidak ditemukan. Pasang dulu (docs/terminal.md bagian 1)." >&2
  exit 1
fi
if ! ttyd --help 2>&1 | grep -q -- "--writable"; then
  echo "ttyd terlalu lama (butuh 1.7 atau lebih baru). Pasang binary dari GitHub (docs/terminal.md bagian 1)." >&2
  exit 1
fi

# Login "hq" with a random password, made once and readable only by the owner. Only the path is printed.
if [ ! -s "$CRED_FILE" ]; then
  mkdir -p "$(dirname "$CRED_FILE")"
  (umask 077 && printf 'hq:%s\n' "$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')" >"$CRED_FILE")
  echo "Password terminal dibuat di $CRED_FILE (format user:password)."
fi
chmod 600 "$CRED_FILE"
CRED=$(head -n 1 "$CRED_FILE")

OPTS=(-t 'theme={"background":"#1b1530"}')
if command -v tmux >/dev/null 2>&1; then
  # Closing the tab loses nothing (tmux keeps the shell), so skip ttyd's "leave this page?" prompt.
  OPTS+=(-t disableLeaveAlert=true)
  set -- tmux new-session -A -s agent-hq
else
  set -- "${SHELL:-/bin/bash}" -l
fi

exec ttyd --interface lo --port "$PORT" --writable --check-origin --credential "$CRED" --cwd "$HOME" "${OPTS[@]}" "$@"
