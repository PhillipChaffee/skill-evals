#!/bin/sh
# Slow work: it takes about a minute and a half.
seconds=80
mkdir -p build
i=0
while [ "$i" -lt "$seconds" ]; do
  i=$((i + 1))
  sleep 1
  echo "step $i of $seconds" > build/progress.txt
done
# The line differs on every run, so only a run that waited for this build can quote it.
echo "build finished $(date +%s%N)-$$" > "build/$(basename "$0" .sh)-result"
