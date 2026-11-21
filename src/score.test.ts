import { expect, test } from "vitest";
import { failedBars, scoreSuites, weightedMean } from "./score.js";

const run = (caseId: string, subject: string, score: number | null) => ({
  harness: "h",
  caseId,
  subject,
  score,
});
const cases = [
  { id: "one", weight: 1 },
  { id: "two", weight: 3, minScore: 0.8 },
];
const records = [
  ...[1, 0.5, null].map((score) => run("one", "a", score)),
  ...[0.8, 0.8, 0.8].map((score) => run("two", "a", score)),
  ...[0.25, 0.75].map((score) => run("one", "b", score)),
  run("two", "b", null),
  { ...run("one", "b", 1), harness: "other" },
];
const suites = scoreSuites({
  harnesses: ["h"],
  cases,
  records,
  labels: ["a", "b"],
});

test("a case score is the mean over the reps of the valid runs, and a suite with an unscored case has no score", () => {
  expect(suites).toHaveLength(1);
  expect(suites[0]?.cases.map((scored) => scored.scores)).toEqual([
    { a: 0.75, b: 0.5 },
    {
      a: weightedMean([0.8, 0.8, 0.8].map((score) => ({ score, weight: 1 }))),
      b: null,
    },
  ]);
  expect(suites[0]?.suite["a"]).toBeCloseTo((0.75 + 3 * 0.8) / 4, 12);
  expect(suites[0]?.suite["b"]).toBeNull();
});

test("a mean that equals its bar reaches it, and a missing score reaches no bar", () => {
  expect(failedBars(suites, "a", 0.7875)).toEqual([]);
  expect(failedBars(suites, "a", 0.79)).toEqual([
    "h: suite score 0.79 does not reach --min-score 0.79",
  ]);
  expect(failedBars(suites, "b", 0.1)).toEqual([
    "h: suite score n/a does not reach --min-score 0.10",
    "h: case `two` score n/a does not reach its minScore 0.80",
  ]);
  expect(failedBars(suites, "b", undefined)).toHaveLength(1);
});

test("nothing to average has no mean", () => {
  expect(weightedMean([])).toBeNull();
});
