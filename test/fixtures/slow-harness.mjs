#!/usr/bin/env node
// Stands in for a harness that never answers: it starts a child that outlives it and then waits, so only a kill of
// its whole process group ends the run. While the child lives, it keeps replacing the file $SLOW_HEARTBEAT_FILE names, atomically.
import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout } from "node:timers";

const HOUR_MS = 3_600_000;
const beat = `
  const fs = require("node:fs");
  const file = process.env.SLOW_HEARTBEAT_FILE;
  let beats = 0;
  // Write a temp file and rename it into place: a kill can land at any moment, and a rename never leaves the
  // heartbeat file empty the way a truncating write can.
  const beat = () => {
    fs.writeFileSync(file + ".tmp", String(++beats));
    fs.renameSync(file + ".tmp", file);
  };
  beat();
  setInterval(beat, 20);
`;
spawn(process.execPath, ["-e", beat], { stdio: "ignore" });
setTimeout(() => {}, HOUR_MS);
