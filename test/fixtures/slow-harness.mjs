#!/usr/bin/env node
// Stands in for a harness that never answers: it starts a child that outlives it and then waits, so only a kill of
// its whole process group ends the run. While the child lives, it keeps rewriting the file $SLOW_HEARTBEAT_FILE names.
import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout } from "node:timers";

const HOUR_MS = 3_600_000;
const beat = `
  const fs = require("node:fs");
  let beats = 0;
  setInterval(() => fs.writeFileSync(process.env.SLOW_HEARTBEAT_FILE, String(++beats)), 20);
`;
spawn(process.execPath, ["-e", beat], { stdio: "ignore" });
setTimeout(() => {}, HOUR_MS);
