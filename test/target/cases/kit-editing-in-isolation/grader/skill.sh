#!/usr/bin/env bash
# Reads the new skill: it exists and opens with front matter that has a name and a description.
set -u
file=skills/release-notes/SKILL.md
[ -f "$file" ] || { echo "no $file"; exit 1; }
[ "$(sed -n 1p "$file")" = "---" ] || { echo "no front matter"; exit 1; }
front=$(sed -n '2,/^---$/p' "$file")
printf '%s\n' "$front" | grep -qE '^name: release-notes$' || { echo "no name"; exit 1; }
printf '%s\n' "$front" | grep -qE '^description: .+' || { echo "no description"; exit 1; }
echo "ok front matter"
