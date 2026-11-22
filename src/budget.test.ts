import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  priced,
  resumeArgs,
  scoreArgs,
  scriptedCase,
} from "./testing/budget.js";
import { readResults, sandbox } from "./testing/sandbox.js";
import { linesIn, plantSuite, startsOf } from "./testing/suite.js";

const PARTIAL = 4;
const RESULTS = "results";
const MAX_COST = "--max-cost";
const MAX_DURATION = "--max-duration";
const TWO = ["alpha", "bravo"];
const CASES = [...TWO, "charlie", "delta"];
const NO_LOCK = (out: string): boolean =>
  !fs.existsSync(path.join(out, ".lock"));

test("--max-cost stops cleanly with exit 4 and partial set", async () => {
  const box = sandbox();
  priced(box, CASES, 0.4);
  const out = path.join(box.root, RESULTS);
  const ran = await box.cli(scoreArgs(box, RESULTS, MAX_COST, "0.5"));
  // 0.4 is under the limit, so a second run starts; 0.8 is over it, so no third does.
  expect(ran.status, ran.stderr).toBe(PARTIAL);
  const results = readResults(out);
  expect(results.partial).toEqual({ reason: "budget" });
  expect(results.records.map((record) => record.caseId)).toEqual(TWO);
  expect(linesIn(out)).toHaveLength(2);
  expect(startsOf(box)).toBe(2);
  expect(NO_LOCK(out)).toBe(true);
  expect(ran.stderr).toContain(
    `skill-evals: stopped at --max-cost after 2 finished runs; continue with --resume ${out}`,
  );
  expect(ran.stderr).toMatch(/\[2\/4\] \$0\.8000 ETA /);
  // The report is still printed.
  expect(ran.stdout).toContain("alpha");
});

test("the budget counts only this command's spend, not reused runs", async () => {
  const box = sandbox();
  priced(box, CASES, 0.4);
  const out = path.join(box.root, RESULTS);
  await box.cli(scoreArgs(box, RESULTS, MAX_COST, "0.5"));
  // The two reused runs cost 0.8, which is over this limit, and are not counted: charlie still starts.
  const resumed = await box.cli(resumeArgs(box, RESULTS, MAX_COST, "0.3"));
  expect(resumed.status, resumed.stderr).toBe(PARTIAL);
  expect(readResults(out).records.map((record) => record.caseId)).toEqual(
    CASES.slice(0, 3),
  );
  expect(resumed.stderr).toContain(
    "alpha subject1: score 1.00 (reused) [1/4] $? ETA --:--",
  );
  expect(resumed.stderr).toContain(
    "bravo subject1: score 1.00 (reused) [2/4] $? ETA --:--",
  );
  expect(resumed.stderr).toMatch(
    /charlie subject1: score 1\.00 \[3\/4\] \$0\.4000 /,
  );
});

test("an interrupted run resumes without repeating finished runs (stopped by --max-duration)", async () => {
  const box = sandbox();
  const cases = plantSuite(box, CASES);
  const out = path.join(box.root, RESULTS);
  const base = ["score", "--subject", "none", "--cases", cases, "--reps", "1"];
  const first = await box.cli([
    ...base,
    ...["--out", out, MAX_DURATION, "0.0002"],
  ]);
  expect(first.status, first.stderr).toBe(PARTIAL);
  const done = readResults(out);
  expect(done.partial).toEqual({ reason: "duration" });
  expect(done.records.length).toBeLessThan(4);
  expect(startsOf(box)).toBe(done.records.length);
  expect(first.stderr).toContain("stopped at --max-duration");

  const second = await box.cli([...base, "--resume", out]);
  expect(second.status, second.stderr).toBe(0);
  // Every run was made once: the stop lost none and repeated none.
  expect(startsOf(box)).toBe(4);
  const { records, partial } = readResults(out);
  expect(partial).toBeNull();
  expect(records.map((record) => record.caseId)).toEqual(CASES);
  expect(linesIn(out)).toHaveLength(4);
});

test("a run in flight at the breach skips its judged checks and is invalid, with skippedGraders", async () => {
  const box = sandbox();
  box.write("fake/judge/replies.json", ['{"score": 1, "reason": "yes"}']);
  scriptedCase(box, "fast", { costUsd: 1 });
  // Slow enough that the fast run has finished, and spent the budget, before this one is graded.
  scriptedCase(box, "slow", {
    before: [
      { call: { name: "Bash", input: { command: "sleep 1" }, exec: true } },
    ],
    checks: [{ type: "judge", rubric: "Says done." }],
  });
  const out = path.join(box.root, RESULTS);
  const args = scoreArgs(box, RESULTS, "--jobs", "2", MAX_COST, "0.5");
  const ran = await box.cli(args);
  expect(ran.status, ran.stderr).toBe(PARTIAL);
  const results = readResults(out);
  expect(results.partial).toEqual({ reason: "budget" });
  const slow = results.records.find((record) => record.caseId === "slow");
  expect(slow?.skippedGraders).toBe(true);
  expect(slow?.score).toBeNull();
  expect(slow?.checks.map((check) => check.score)).toEqual([1, null]);
  expect(slow?.checks[1]?.reason).toBe("skipped: budget reached");
  expect(results.invalid).toEqual([
    "claude-code slow subject1: a judged check has no score: skipped: budget reached",
  ]);
  expect(
    results.records.find((record) => record.caseId === "fast"),
  ).not.toHaveProperty("skippedGraders");
  expect(fs.existsSync(path.join(box.root, "fake/judge/prompts.jsonl"))).toBe(
    false,
  );

  // The run that was skipped is invalid, so a resume makes it again in full, and the judge answers it.
  const resumed = await box.cli(resumeArgs(box, RESULTS));
  expect(resumed.status, resumed.stderr).toBe(0);
  // The fast run, the slow run, and then the slow run again with its judge.
  expect(startsOf(box)).toBe(4);
  const again = readResults(out).records.find(
    (record) => record.caseId === "slow",
  );
  expect(again?.score).toBe(1);
  expect(again).not.toHaveProperty("skippedGraders");
});

test("a time limit skips the graders of a run in flight too", async () => {
  const box = sandbox();
  box.write("fake/judge/replies.json", ['{"score": 1, "reason": "yes"}']);
  // The limit, 0.6 s, falls inside the run's one second of work, with a margin on both sides.
  scriptedCase(box, "slow", {
    before: [
      { call: { name: "Bash", input: { command: "sleep 1" }, exec: true } },
    ],
    checks: [{ type: "judge", rubric: "Says done." }],
  });
  const ran = await box.cli(scoreArgs(box, RESULTS, MAX_DURATION, "0.01"));
  expect(ran.status, ran.stderr).toBe(PARTIAL);
  const [record] = readResults(path.join(box.root, RESULTS)).records;
  expect(record?.checks[1]?.reason).toBe("skipped: duration reached");
  expect(record?.skippedGraders).toBe(true);
});

test("a decision check is skipped at the breach as well", async () => {
  const box = sandbox();
  scriptedCase(box, "fast", { costUsd: 1 });
  scriptedCase(box, "slow", {
    before: [
      { call: { name: "Bash", input: { command: "sleep 1" }, exec: true } },
    ],
    checks: [{ type: "decision", question: "Is it plain?", expect: "yes" }],
  });
  // Decision checks report no cost, so only the time limit may be set with them.
  const ran = await box.cli(
    scoreArgs(
      box,
      "results",
      ...["--jobs", "2", MAX_DURATION, "0.01"],
      ...["--decision-model", "m", "--decision-url", "http://127.0.0.1:9"],
    ),
    { BASETEN_API_KEY: "k" },
  );
  expect(ran.status, ran.stderr).toBe(PARTIAL);
  const slow = readResults(path.join(box.root, RESULTS)).records.find(
    (record) => record.caseId === "slow",
  );
  expect(slow?.checks[1]?.reason).toBe("skipped: duration reached");
  expect(slow?.skippedGraders).toBe(true);
  expect(slow?.decision).toBeNull();
});

test("a budget on a harness that sometimes reports no cost warns once", async () => {
  const box = sandbox();
  priced(box, TWO, 0.1);
  // These two state no cost.
  scriptedCase(box, "free");
  scriptedCase(box, "free2");
  const ran = await box.cli(scoreArgs(box, RESULTS, MAX_COST, "100"));
  expect(ran.status, ran.stderr).toBe(0);
  const warnings = ran.stderr
    .split("\n")
    .filter((line) => line.includes("not reported"));
  expect(warnings).toEqual([
    "skill-evals: warning: 2 costs were not reported (agent attempts and judge replies); the budget counts only reported costs",
  ]);
  const none = await box.cli(scoreArgs(box, "second"));
  expect(none.stderr).not.toContain("not reported");
});

test("the progress line ends with [n/N], the spend and the time left", async () => {
  const box = sandbox();
  priced(box, CASES.slice(0, 3), 0.25);
  const ran = await box.cli(scoreArgs(box, RESULTS));
  expect(ran.status, ran.stderr).toBe(0);
  const lines = ran.stderr.trim().split("\n");
  expect(lines).toHaveLength(3);
  expect(
    lines.map((line) => line.replace(/ETA \d\d:\d\d$/, "ETA <time>")),
  ).toEqual([
    "claude-code alpha subject1: score 1.00 [1/3] $0.2500 ETA <time>",
    "claude-code bravo subject1: score 1.00 [2/3] $0.5000 ETA <time>",
    "claude-code charlie subject1: score 1.00 [3/3] $0.7500 ETA <time>",
  ]);
  expect(lines[2]).toMatch(/ETA 00:00$/);
});

test("the progress line says $? when no run reports a cost, and ETA --:-- before a run finishes", async () => {
  const box = sandbox();
  plantSuite(box, TWO);
  const ran = await box.cli(scoreArgs(box, RESULTS));
  expect(ran.stderr).toMatch(
    /alpha subject1: score 1\.00 \[1\/2\] \$\? ETA \d\d:\d\d\n/,
  );
  const again = await box.cli(resumeArgs(box, RESULTS));
  expect(again.stderr).toContain(
    "alpha subject1: score 1.00 (reused) [1/2] $? ETA --:--",
  );
  expect(again.stderr).toContain(
    "bravo subject1: score 1.00 (reused) [2/2] $? ETA --:--",
  );
});
