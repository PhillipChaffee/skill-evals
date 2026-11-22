#!/bin/sh
# Slow work: the result is written at the end, and the marker file after it.
sleep 1
mkdir -p build
echo "build ok" > build/result.txt
touch build/done.flag
