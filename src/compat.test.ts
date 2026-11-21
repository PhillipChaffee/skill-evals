import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { plugin } from "./testing/plant.js";
import { readResults, sandbox } from "./testing/sandbox.js";

// The 0.0.1 cases of test/compat/cases, and what 0.0.1 scored them. The literals were captured from the code before
// any of the extension work began, and a change to them is a change to what users' existing suites score.
const CASES = path.resolve(import.meta.dirname, "../test/compat/cases");

/** What a case scored: the run's score, then each check's score in the order of the case file. */
type Expected = [score: number, checks: number[]];

const ALL_ARMS: Record<string, Expected> = {
  "answer-text": [0.7142857142857143, [1, 0, 1, 0, 1]],
  bare: [0.75, [1, 0, 1, 1]],
};
// With the plugin loaded, which loads the skill `bro` on every run and writes `summary by kit`.
const LOADED: Record<string, Expected> = {
  ...ALL_ARMS,
  "skills-used": [0.5, [1, 0, 0, 1, 1]],
  "tool-use": [0.3333333333333333, [0, 0, 1, 0, 1]],
  "written-files": [0.6666666666666666, [1, 0, 1, 1, 1]],
};
// With no subject, the agent loads nothing and writes `summary by plain`.
const PLAIN: Record<string, Expected> = {
  ...ALL_ARMS,
  "skills-used": [0.3333333333333333, [0, 1, 0, 1, 0]],
  "tool-use": [0.6666666666666666, [0, 0, 1, 1, 1]],
  "written-files": [0.5, [1, 0, 1, 0, 1]],
};
const LOADED_SUITE = 0.5952380952380952;
const PLAIN_SUITE = 0.5063492063492064;

/**
 * Copies the frozen cases into a sandbox, with a plugin whose agent loads the skill `bro`.
 * @returns The sandbox, the cases directory, and the plugin directory.
 */
function planted() {
  const box = sandbox();
  const cases = path.join(box.root, "cases");
  fs.cpSync(CASES, cases, { recursive: true });
  return { box, cases, kit: plugin(box, "kit", { skill: "bro" }) };
}

/**
 * Checks every score of one subject against what 0.0.1 gave.
 * @param outDir - Where the command wrote its results.
 * @param given - The subject's label in the results, the run score and check scores for each case, and the suite score.
 * @param given.label - The subject's label.
 * @param given.cases - What each case scored.
 * @param given.suite - What the suite scored.
 */
function expectScores(
  outDir: string,
  given: { label: string; cases: Record<string, Expected>; suite: number },
) {
  const { label, cases: expected, suite } = given;
  const { suites, records } = readResults(outDir);
  const ours = records.filter((record) => record.subject === label);
  expect(ours.map((record) => record.caseId).sort()).toEqual(
    Object.keys(expected),
  );
  for (const record of ours) {
    const [score, checks] = expected[record.caseId] ?? [NaN, []];
    expect(record.ok, record.caseId).toBe(true);
    expect(record.score, record.caseId).toBeCloseTo(score, 12);
    expect(
      record.checks.map((check) => check.score),
      record.caseId,
    ).toEqual(checks);
    const scored = suites[0]?.cases.find((each) => each.id === record.caseId);
    expect(scored?.scores[label], record.caseId).toBeCloseTo(score, 12);
  }
  expect(suites[0]?.suite[label]).toBeCloseTo(suite, 12);
}

test("score gives every frozen case, and the suite, the score 0.0.1 gave", async () => {
  const { box, cases, kit } = planted();
  const outDir = path.join(box.root, "results");
  const result = await box.cli([
    "score",
    "--subject",
    kit,
    "--cases",
    cases,
    "--reps",
    "1",
    "--out",
    outDir,
  ]);
  // `written-files` ends below its minScore; `skills-used` ends exactly on its own, which reaches it.
  expect(result.status, result.stderr).toBe(1);
  expectScores(outDir, {
    label: "subject",
    cases: LOADED,
    suite: LOADED_SUITE,
  });
  expect(readResults(outDir).belowBar).toEqual([
    "claude-code: case `written-files` score 0.67 does not reach its minScore 0.90",
  ]);
});

test("run gives both subjects of every frozen case, and the suites, the scores 0.0.1 gave", async () => {
  const { box, cases, kit } = planted();
  const outDir = path.join(box.root, "results");
  const result = await box.cli([
    "run",
    "--a",
    "none",
    "--b",
    kit,
    "--cases",
    cases,
    "--reps",
    "1",
    "--out",
    outDir,
  ]);
  expect(result.status, result.stderr).toBe(1);
  expectScores(outDir, { label: "a", cases: PLAIN, suite: PLAIN_SUITE });
  expectScores(outDir, { label: "b", cases: LOADED, suite: LOADED_SUITE });
});
