import path from "node:path";
import { expect, test } from "vitest";
import { priced, scoreArgs, scriptedCase } from "./testing/budget.js";
import { readResults, sandbox } from "./testing/sandbox.js";
import { startsOf } from "./testing/suite.js";

const PARTIAL = 4;
const RESULTS = "results";
const MAX_COST = "--max-cost";

test("a command that stopped at its budget says so in the report and lists the runs that did not run", async () => {
  const box = sandbox();
  priced(box, ["alpha", "bravo", "charlie", "delta"], 0.4);
  const ran = await box.cli(scoreArgs(box, RESULTS, MAX_COST, "0.5"));
  expect(ran.status, ran.stderr).toBe(PARTIAL);
  expect(ran.stdout).toContain("## Stopped early");
  expect(ran.stdout).toContain("The command stopped at --max-cost (budget).");
  expect(ran.stdout).toContain(
    "- claude-code SUBJECT: 2 of 4 runs did not run; scores cover finished runs only",
  );
  const results = readResults(path.join(box.root, RESULTS));
  expect(results.notRun).toEqual([
    { harness: "claude-code", caseId: "charlie", subject: "subject", rep: 1 },
    { harness: "claude-code", caseId: "delta", subject: "subject", rep: 1 },
  ]);
  // A command that ran to the end has no section and nothing in notRun.
  const whole = await box.cli(scoreArgs(box, "whole"));
  expect(whole.stdout).not.toContain("Stopped early");
  expect(readResults(path.join(box.root, "whole")).notRun).toEqual([]);
});

test("a comparison whose sides finished different numbers of runs says so", async () => {
  const box = sandbox();
  priced(box, ["only"], 0.3);
  const ran = await box.cli([
    ...["run", "--a", "none", "--b", "none", "--reps", "2"],
    ...["--cases", path.join(box.root, "suite")],
    ...["--out", path.join(box.root, RESULTS), MAX_COST, "0.7"],
  ]);
  expect(ran.status, ran.stderr).toBe(PARTIAL);
  // A1, b1 and a2 ran, which cost 0.9; b2 did not.
  expect(ran.stdout).toContain(
    "- claude-code B: 1 of 2 runs did not run; scores cover finished runs only",
  );
  expect(ran.stdout).toContain(
    "the subjects finished different numbers of runs (A 2, B 1), so the comparison is not over the same reps",
  );
});

test("a run whose own agent cost reaches the budget does not start its judge", async () => {
  const box = sandbox();
  box.write("fake/judge/replies.json", ['{"score": 1, "reason": "yes"}']);
  scriptedCase(box, "dear", {
    costUsd: 1,
    checks: [{ type: "judge", rubric: "Says done." }],
  });
  const ran = await box.cli(scoreArgs(box, RESULTS, MAX_COST, "0.5"));
  expect(ran.status, ran.stderr).toBe(PARTIAL);
  const [record] = readResults(path.join(box.root, RESULTS)).records;
  expect(record?.checks[1]?.reason).toBe("skipped: budget reached");
  expect(record?.skippedGraders).toBe(true);
  // Only the agent started: the judge was never asked.
  expect(startsOf(box)).toBe(1);
});

test("the report says how many runs were retried, and what the failed attempts cost", async () => {
  const box = sandbox();
  scriptedCase(box, "solo", {
    before: [{ onStart: [1], step: { crash: "segfault" } }],
  });
  const ran = await box.cli(scoreArgs(box, RESULTS, "--retries", "1"));
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("## Retried runs");
  expect(ran.stdout).toMatch(
    /1 of 1 runs were retried\. The 1 failed attempts took \d+\.\d s in total, not counted in the table\./,
  );
  const [record] = readResults(path.join(box.root, RESULTS)).records;
  expect(record?.attempts?.[0]).toMatchObject({
    error: "no result event",
    costUsd: null,
  });
  expect(record?.attempts?.[0]?.durationMs).toBeGreaterThan(0);
});
