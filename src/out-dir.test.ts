import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { evaluate } from "./evaluate.js";
import { startTimeOf } from "./lock.js";
import { asProcess, readResults, sandbox } from "./testing/sandbox.js";
import { linesIn, plantSuite } from "./testing/suite.js";

const ids = ["alpha", "bravo", "charlie"];

/**
 * Writes the lock of a live process that is not this one.
 * @param out - The output directory.
 */
function heldByAnother(out: string): void {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  const pid = child.pid as number;
  fs.writeFileSync(
    path.join(out, ".lock"),
    JSON.stringify({
      pid,
      hostname: os.hostname(),
      bootId: null,
      startTime: startTimeOf(pid),
    }),
  );
}

test("a directory that a live command holds gives the lock message even when it holds runs", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids);
  const out = path.join(box.root, "results");
  const args = [
    "score",
    "--subject",
    "none",
    "--cases",
    cases,
    "--reps",
    "1",
    "--out",
    out,
  ];
  expect((await box.cli(args)).status).toBe(0);
  heldByAnother(out);
  const ran = await box.cli(args, { KEEP_RUNS: "1" });
  expect(ran.status).toBe(2);
  expect(ran.stderr).toContain(`${path.join(out, ".lock")}: process`);
  expect(ran.stderr).not.toContain("holds 3 runs");
  const resumed = await box.cli([
    "score",
    ...args.slice(1, -2),
    "--resume",
    out,
  ]);
  expect(resumed.status).toBe(2);
  expect(resumed.stderr).toContain(".lock");
});

test("--dry-run raises what the command would about an output directory that holds runs", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids);
  const out = path.join(box.root, "results");
  const base = [
    "--subject",
    "none",
    "--cases",
    cases,
    "--reps",
    "1",
    "--out",
    out,
  ];
  await box.cli(["score", ...base]);
  const dry = await box.cli(["score", ...base, "--dry-run"]);
  expect(dry.status).toBe(2);
  expect(dry.stderr).toContain("holds 3 runs of an earlier command");
  expect(dry.stdout).toBe("");
  // `plan` names such a directory to read it.
  const plan = await box.cli(["plan", ...base]);
  expect(plan.status, plan.stderr).toBe(0);
  expect(plan.stdout).toContain("3 of 3 runs would be reused");
  // A resume dry run is fine.
  const resume = await box.cli([
    "score",
    ...base.slice(0, -2),
    "--resume",
    out,
    "--dry-run",
  ]);
  expect(resume.status, resume.stderr).toBe(0);
});

test("a run that throws leaves results.json saying error, with the runs that finished", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids);
  const out = path.join(box.root, "results");
  const real = fs.appendFileSync.bind(fs);
  let appends = 0;
  const spy = vi.spyOn(fs, "appendFileSync").mockImplementation((...args) => {
    appends++;
    if (appends === 2)
      throw Object.assign(
        new Error("EISDIR: illegal operation on a directory"),
        { code: "EISDIR" },
      );
    real(...args);
  });
  try {
    await expect(
      asProcess({ env: box.env, cwd: box.root }, () =>
        evaluate({ subjects: ["none"], cases, reps: 1, outDir: out }),
      ),
    ).rejects.toThrow(/EISDIR/);
  } finally {
    spy.mockRestore();
  }
  const results = readResults(out);
  expect(results.partial).toEqual({ reason: "error" });
  expect(results.records).toHaveLength(1);
  expect(linesIn(out)).toHaveLength(1);
  // The lock went with the command.
  expect(fs.existsSync(path.join(out, ".lock"))).toBe(false);
});

test("a directory filled while the subject was exported is refused once the lock is held, and its runs are kept", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids);
  box.write("kit/one/SKILL.md", "skill\n");
  const out = path.join(box.root, "results");
  fs.mkdirSync(out);
  const real = fs.cpSync.bind(fs);
  let filled = false;
  const spy = vi.spyOn(fs, "cpSync").mockImplementation((...args) => {
    // The subject is exported between the early check and the lock: another command finishes there.
    if (!filled) {
      filled = true;
      fs.writeFileSync(path.join(out, "results.jsonl"), "kept\n");
    }
    real(...args);
  });
  try {
    await expect(
      asProcess({ env: box.env, cwd: box.root }, () =>
        evaluate({
          subjects: [path.join(box.root, "kit")],
          cases,
          reps: 1,
          outDir: out,
        }),
      ),
    ).rejects.toThrow(/holds 1 runs of an earlier command/);
  } finally {
    spy.mockRestore();
  }
  expect(fs.readFileSync(path.join(out, "results.jsonl"), "utf8")).toBe(
    "kept\n",
  );
  expect(fs.existsSync(path.join(out, ".lock"))).toBe(false);
});
