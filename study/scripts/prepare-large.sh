#!/usr/bin/env bash
# The larger case: clones node-express-boilerplate (49 files, ~3,600 lines) at a fixed commit
# and puts the agent prompt (task + hidden line) on the clipboard.
set -euo pipefail
STUDY="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${1:-/tmp/neb-run}"
CONFIG="$STUDY/hidden_change_large.json"
if [ -e "$RUN" ]; then
  echo "$RUN already exists. Remove it or pass another path." >&2
  exit 1
fi
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$CONFIG" "$1"; }
git clone -q "$(field repo)" "$RUN"
cd "$RUN"
git checkout -q "$(field commit)"
git remote remove origin
printf "%s\n\n%s\n" "$(cat "$STUDY/cases/large-soft-delete.md")" "$(field text)" | pbcopy
echo "Repo ready at $RUN ($(git ls-files | wc -l | tr -d ' ') files, commit $(git rev-parse --short HEAD))."
echo "Agent prompt (task + hidden line) copied to the clipboard."
