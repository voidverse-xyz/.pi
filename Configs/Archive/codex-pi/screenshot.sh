#!/bin/bash
# Screenshot the codex-pi TUI in a KDE konsole inside fedora-desktop.
#
# KDE here runs on Wayland (Xwayland :1). Two obstacles that this script solves:
#  1. xdotool synthetic keys don't reach pi's raw-mode stdin, and konsole's
#     DBus sendText is disabled by KDE security policy. FIX: run pi inside tmux
#     and inject input with `tmux send-keys` (tmux owns the pty).
#  2. Full-screen scrot is blank under Wayland. FIX: `import -window <id>` grabs
#     the konsole Xwayland window directly.
#
# Usage: ./screenshot.sh <out.png> [command-to-type ...]
#   e.g. ./screenshot.sh status.png "/status"
set -e
OUT="${1:-shot.png}"; shift || true
C=fedora-desktop
S=picodex   # tmux session name

docker exec -u abc "$C" bash -lc "
  pkill -9 konsole 2>/dev/null || true
  tmux kill-session -t $S 2>/dev/null || true
  sleep 1
  printf 'set -g status off\nset -g extended-keys on\n' > ~/.tmux.conf
  tmux new-session -d -s $S -x 180 -y 44
  tmux send-keys -t $S 'cd /config/workspace/test-project && OPENAI_API_KEY=sk-test pi' Enter
  DISPLAY=:1 konsole --profile Shell -e tmux attach -t $S >/tmp/konsole.log 2>&1 &
  sleep 8
  WID=\$(DISPLAY=:1 xdotool search --class konsole | head -1)
  DISPLAY=:1 xdotool windowsize \"\$WID\" 1180 760 || true
  echo \"\$WID\" > /tmp/wid
"

for cmd in "$@"; do
  docker exec -u abc "$C" bash -lc "
    tmux send-keys -t $S -l '$cmd'
    sleep 0.3
    tmux send-keys -t $S Enter
    sleep 3
  "
done

docker exec -u abc "$C" bash -lc '
  WID=$(cat /tmp/wid)
  DISPLAY=:1 import -window "$WID" /tmp/_shot.png
'
docker cp "$C":/tmp/_shot.png "$OUT"
echo "wrote $OUT"
