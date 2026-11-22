#!/usr/bin/env bash
# Reads the repository the agent left: one new file, untracked, and no commit besides the first.
set -u
status=$(git status --porcelain)
lines=$(printf '%s\n' "$status" | grep -c . || true)
commits=$(git log --oneline | grep -c . || true)
if [ "$lines" -ne 1 ]; then
  echo "status shows $lines entries: $status"
  exit 1
fi
case "$status" in
  "?? docs/research/"*) ;;
  *) echo "not an untracked file under docs/research/: $status"; exit 1 ;;
esac
if [ "$commits" -ne 1 ]; then
  echo "$commits commits"
  exit 1
fi
echo "ok untracked, $commits commit"
