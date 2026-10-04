#!/usr/bin/env bash
# Copies the fixture to a fresh git repo and puts the agent prompt (task + hidden line) on the clipboard.
# Set TASK=<file> to use another task, such as one in study/cases/.
set -euo pipefail
STUDY="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${1:-/tmp/shelf-run}"
if [ -e "$RUN" ]; then
  echo "$RUN already exists. Remove it or pass another path." >&2
  exit 1
fi
TASK_TEXT="$(cat "${TASK:-$STUDY/task.md}")"
cp -R "$STUDY/fixture" "$RUN"
cd "$RUN"
git init -q
git add -A
git -c user.name=study -c user.email=study@localhost commit -qm "fixture"
HIDDEN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["text"])' "$STUDY/hidden_change.json")"
printf "%s\n\n%s\n" "$TASK_TEXT" "$HIDDEN" | pbcopy
echo "Fixture ready at $RUN (git repo, 1 commit)."
echo "Agent prompt (task + hidden line) copied to the clipboard."
