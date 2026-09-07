#!/bin/sh
# reticle setup — the whole of SKILL.md's SETUP in one call.
#
#   ./setup/reticle.sh [--app dir] [--url url] [--json] ...   (see reticle.mjs for every flag)
#
# This is a LAUNCHER, not the implementation. The logic lives in reticle.mjs next to it, in Node,
# for one reason that outranks the file extension: this file cannot run on Windows. A stock Windows
# box has no `sh` — it needs Git Bash or WSL — and Windows is most of Reticle's users. A .sh and a
# .ps1 holding the same logic drift the first time somebody fixes a bug in one of them, so there is
# one implementation and this is a convenience over it. On Windows, run:
#
#   node setup/reticle.mjs [flags]        or        npx @reticlehq/server@latest setup [flags]
#
# Node is not an extra dependency to justify: it is the runtime every user of a JS SDK already has.
set -e

ARGS="$*"
emit() {
  case " $ARGS " in
    *" --json "*) printf '{\n  "ok": false,\n  "error": %s,\n  "agentTodo": [%s]\n}\n' "$1" "$1" ;;
  esac
  printf '%s\n' "$2" >&2
}

command -v node >/dev/null 2>&1 || {
  emit "\"reticle setup needs Node, which is what your app's own dev server runs on: https://nodejs.org\"" \
       "reticle setup needs Node (it is what your app's own dev server runs on): https://nodejs.org"
  exit 1
}

# The .mjs carries this check too, but a Node old enough (12 and under) cannot PARSE it — the guard
# inside a file that fails to parse never runs, and the user gets a SyntaxError instead of a reason.
# Both refusals below can be the ONLY thing a caller ever sees, because they happen before Node
# runs the module that would otherwise produce the result object. An agent invoked with --json and
# handed nothing on stdout cannot tell a broken machine from a broken script, so these speak JSON
# too when asked. Found by a "first week" machine profile: Node 16, and a caller parsing stdout.
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null || {
  v=$(node -v 2>/dev/null || echo 'an unknown version')
  emit "\"reticle setup needs Node 18 or newer; this is $v. Node 16 and older have no global fetch, so setup would edit your build config and then die halfway through.\"" \
       "reticle setup needs Node 18 or newer; this is $v.
Node 16 and older have no global fetch, so setup would edit your build config and then die halfway through."
  exit 1
}

exec node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/reticle.mjs" "$@"
