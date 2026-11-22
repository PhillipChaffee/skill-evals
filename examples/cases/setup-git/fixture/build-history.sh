#!/usr/bin/env bash
# Runs in the workspace during setup. The agent finds only the repository it builds.
set -euo pipefail
git checkout -q -b feature/prices
for n in 1 2 3 4 5 6; do
  echo "export const step$n = $n;" >> src/prices.js
  git add -A
  git commit -q -m "wip $n"
done
