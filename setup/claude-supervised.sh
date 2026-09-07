#!/bin/sh
# Launch Claude Code under a supervisor, so a restart can be automatic.
#
#   ./setup/claude-supervised.sh [any claude args]
#
# Why this file has to exist at all: a client reads its MCP server list ONCE, at startup, and
# nothing running inside the process can make it re-read that list — not a skill, not a hook, not a
# slash command. Gemini's `/mcp reload` re-discovers from the map built at startup and does not
# re-read settings.json either, so this is structural across clients rather than one client's quirk.
#
# A restart is therefore the only way, and only whatever LAUNCHED the process can perform one. This
# is that launcher: it runs Claude in a loop, and when `reticle.sh --relaunch` leaves a handoff file
# naming a session, it relaunches with `--resume` so the conversation carries on with its context.
#
# You do not need this to onboard. `reticle.sh` produces its verdict from a CHILD process that reads
# the MCP list at its own startup, so the tools reach the caller whenever it next starts anyway.
# This only removes the wait.
set -eu

HANDOFF_DIR="${CL_HANDOFF_DIR:-$HOME/.claude-shared/cl-handoff}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

command -v "$CLAUDE_BIN" >/dev/null 2>&1 || { echo "no \`$CLAUDE_BIN\` on PATH" >&2; exit 1; }

# One token per run, exported so the script we launch can name its handoff file. A switch in one
# terminal can then never be collected by another, and a stale file is inert rather than dangerous.
CL_RUN="$(uuidgen 2>/dev/null || date +%s%N)"
export CL_RUN
handoff="$HANDOFF_DIR/$CL_RUN"
mkdir -p "$HANDOFF_DIR"
rm -f "$handoff"

# `trap` rather than tidying up at the end: ^C and SIGTERM both leave the loop without reaching it,
# and a handoff left on disk is a file nobody will ever collect.
trap 'rm -f "$handoff"' EXIT INT TERM

args="$*"
while :; do
  # `set +e` for this line only: Claude exiting non-zero is ordinary — 130 for ^C, 143 for the
  # SIGTERM a handoff sends — and none of it should kill the supervisor.
  set +e
  # shellcheck disable=SC2086
  "$CLAUDE_BIN" $args
  set -e

  [ -f "$handoff" ] || break

  # Read and delete BEFORE acting: a handoff that survives its own turn relaunches forever.
  session="$(cut -f2 "$handoff" | head -1)"
  rm -f "$handoff"
  [ -n "$session" ] || { echo "the handoff named no session — staying put" >&2; break; }

  # A session id with no transcript behind it is the failure that LOOKS like success: --resume on an
  # unknown id opens an EMPTY conversation under that id, with no error anywhere.
  found=""
  for f in "$HOME"/.claude*/projects/*/"$session.jsonl" "$HOME"/.claude-shared/projects/*/"$session.jsonl"; do
    [ -f "$f" ] && found="$f" && break
  done
  [ -n "$found" ] || { echo "no transcript for $session — refusing to resume into an empty conversation" >&2; break; }

  echo "→ restarting with the reticle tools loaded (resuming $session)"
  args="--resume $session"
done
