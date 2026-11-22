import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { EXIT } from "./exit-codes.js";
import {
  FIXED,
  NEVER,
  REJUDGED,
  judged,
  plantOther,
  resultsIn,
  scoreInto,
  scoredWith,
} from "./testing/rejudge.js";

const STORED = "results/results.json";

test("a case missing from the cases directory keeps its records and is listed", async () => {
  const scored = await scoredWith([FIXED]);
  plantOther(scored, [FIXED]);
  const both = await scoreInto(scored, "both");
  fs.rmSync(path.join(scored.cases, "other"), { recursive: true });
  scored.rewrite([NEVER]);
  const ran = await scored.box.cli(["rejudge", both, "--cases", scored.cases]);
  expect(ran.stderr).toContain(
    "other subject1: kept unchanged: the case is not in the cases directory",
  );
  const done = resultsIn(both, REJUDGED);
  const byCase = Object.fromEntries(
    done.records.map((one) => [one.caseId, one.score]),
  );
  expect(byCase).toEqual({ other: 1, restate: 0 });
  expect(done.suites[0]?.cases.map((one) => one.id)).toEqual([
    "other",
    "restate",
  ]);
  expect(ran.stdout).toContain("other");
});

test("--case limits the re-scoring and keeps the other cases as they were", async () => {
  const scored = await scoredWith([FIXED]);
  plantOther(scored, [FIXED]);
  const both = await scoreInto(scored, "both");
  scored.rewrite([NEVER]);
  plantOther(scored, [NEVER]);
  const ran = await scored.box.cli([
    "rejudge",
    both,
    "--cases",
    scored.cases,
    "--case",
    "restate",
  ]);
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  const byCase = Object.fromEntries(
    resultsIn(both, REJUDGED).records.map((one) => [one.caseId, one.score]),
  );
  expect(byCase).toEqual({ other: 1, restate: 0 });
});

test("a case that no longer applies to the harness keeps its records and is listed", async () => {
  const scored = await scoredWith([FIXED]);
  plantOther(scored, [FIXED]);
  const both = await scoreInto(scored, "both");
  scored.box.write("cases/other/case.json", {
    checks: [NEVER],
    requires: ["bin:nothing-of-the-sort"],
  });
  const ran = await scored.box.cli(["rejudge", both, "--cases", scored.cases]);
  expect(ran.stderr).toContain(
    "other subject1: kept unchanged: the case does not apply to claude-code now",
  );
  const done = resultsIn(both, REJUDGED);
  expect(done.records.map((one) => one.score)).toEqual([1, 1]);
});

test("rejudge refuses results of a harness this version does not know", async () => {
  const scored = await scoredWith([FIXED]);
  const stored = resultsIn(scored.out);
  scored.box.write(STORED, { ...stored, harnesses: ["ghost"] });
  const ran = await scored.rejudge();
  expect(ran.status).toBe(EXIT.usage);
  expect(ran.stderr).toContain("the harness ghost");
});

test("rejudge refuses results without meta", async () => {
  const scored = await scoredWith([FIXED]);
  const stored = resultsIn(scored.out);
  scored.box.write(STORED, { ...stored, meta: undefined });
  const ran = await scored.rejudge();
  expect(ran.status).toBe(EXIT.usage);
  expect(ran.stderr).toContain("lack the meta");
});

test("a judged check needs the harness or a judge to ask", async () => {
  const scored = await scoredWith([FIXED]);
  scored.rewrite([judged("It names the fix.")]);
  const ran = await scored.rejudge([], {
    SKILL_EVALS_BIN_CLAUDE_CODE: "/nonexistent",
  });
  expect(ran.status).toBe(EXIT.usage);
  expect(ran.stderr).toContain("a judged check needs the harness claude-code");
});

test("a run with no transcript file named is kept and listed", async () => {
  const scored = await scoredWith([FIXED]);
  const stored = resultsIn(scored.out);
  const [record] = stored.records;
  scored.box.write(STORED, {
    ...stored,
    records: [{ ...record, transcriptFile: null }],
  });
  scored.rewrite([NEVER]);
  const ran = await scored.rejudge();
  expect(ran.stderr).toContain("has no transcript file");
});

test("a run of the none subject is re-scored without a subject to compare", async () => {
  const scored = await scoredWith([FIXED]);
  const none = path.join(scored.box.root, "none");
  await scored.box.cli([
    ...["score", "--subject", "none", "--cases", scored.cases],
    ...["--reps", "1", "--out", none],
  ]);
  scored.rewrite([NEVER]);
  const ran = await scored.box.cli(["rejudge", none, "--cases", scored.cases]);
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  expect(resultsIn(none, REJUDGED).records[0]?.score).toBe(0);
});
