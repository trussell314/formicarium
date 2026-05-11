#!/bin/bash
# Launch a long-running command in a fully-detached process so it
# survives a Claude Code session pause/resume. Background processes
# spawned with plain `cmd &` from a Bash tool call are children of
# the agent's shell — when the session is paused, that shell goes
# away and takes the children with it. This script re-parents the
# child to init via three combined defences:
#   • setsid    — new session + process group, detaches from tty
#   • nohup     — child ignores SIGHUP from the dying parent shell
#   • disown    — the parent's job table forgets the child, so a
#                 shell exit doesn't propagate signals to it
# Stdin is redirected from /dev/null and stdout/stderr go to the
# named log file. The script prints PID and LOG, then exits.
#
# Usage:
#   scripts/detached-run.sh <log-path> <command...>
#
# Example (1M-tick master run):
#   scripts/detached-run.sh /tmp/m1m.log \
#     npx vitest run --config vitest.monitor.config.ts \
#       tests/_master.test.ts --testTimeout=7200000 --reporter=basic
#
# Check status:
#   kill -0 <PID> 2>/dev/null && echo running || echo done
#
# Tail the log:
#   tail -f <LOG>
set -euo pipefail
if [ $# -lt 2 ]; then
  echo "Usage: $0 <log-path> <command...>" >&2
  exit 2
fi
LOG="$1"; shift
: > "$LOG"
setsid nohup "$@" </dev/null >>"$LOG" 2>&1 &
PID=$!
disown $PID 2>/dev/null || true
echo "PID=$PID LOG=$LOG"
