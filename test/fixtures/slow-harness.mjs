#!/usr/bin/env node
// Stands in for a harness that never answers: it starts a child that outlives it and then waits, so only a kill of
// its whole process group ends the run. While the child lives, it keeps replacing the file $SLOW_HEARTBEAT_FILE names, atomically.
// $SLOW_LATE: see its use below. $SLOW_PID_FILE names a file that gets the child's process id. $SLOW_TURNS, a number, makes it first write that many
// Claude Code shaped assistant events ("turn 1", "turn 2", ...), one per line, so a run can be stopped in the middle.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import process from "node:process";
import { setTimeout } from "node:timers";

// A question about the version is answered at once, and starts nothing.
if (process.argv.includes("--version")) {
  process.stdout.write("slow-harness 1.0.0\n");
  process.exit(0);
}

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
const child = spawn(process.execPath, ["-e", beat], { stdio: "ignore" });
if (process.env.SLOW_PID_FILE) {
  writeFileSync(process.env.SLOW_PID_FILE, String(child.pid));
}
// The turns wait for the child's first beat, so a test that stops the run early still has a child to look for.
const MS_PER_POLL = 10;
const MS_PER_TURN = 30;
while (
  process.env.SLOW_HEARTBEAT_FILE &&
  !existsSync(process.env.SLOW_HEARTBEAT_FILE)
) {
  await new Promise((resolve) => setTimeout(resolve, MS_PER_POLL));
}
for (let turn = 1; turn <= Number(process.env.SLOW_TURNS ?? 0); turn += 1) {
  const message = {
    id: `msg_${turn}`,
    role: "assistant",
    content: [{ type: "text", text: `turn ${turn}` }],
  };
  process.stdout.write(`${JSON.stringify({ type: "assistant", message })}\n`);
  // A model takes time between turns, so each turn is its own chunk.
  await new Promise((resolve) => setTimeout(resolve, MS_PER_TURN));
}
// $SLOW_LATE, set to anything, makes a helper in a session of its own, so that no kill of the group reaches it, wait
// until this process is gone and then write two more turns into the harness's output: a test aims it at the drain
// window after a timeout without depending on the speed of the machine.
if (process.env.SLOW_LATE) {
  const late = `
    const parent = ${process.pid};
    const alive = () => { try { process.kill(parent, 0); return true; } catch { return false; } };
    const wait = setInterval(() => {
      if (alive()) return;
      clearInterval(wait);
      for (const id of ["late_1", "late_2"]) {
        const message = { id, role: "assistant", content: [{ type: "text", text: id }] };
        process.stdout.write(JSON.stringify({ type: "assistant", message }) + "\\n");
      }
    }, 2);`;
  spawn(process.execPath, ["-e", late], {
    detached: true,
    stdio: ["ignore", "inherit", "ignore"],
  });
}
setTimeout(() => {}, HOUR_MS);
