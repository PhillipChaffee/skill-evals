import { expect, test } from "vitest";
import { noteSections } from "./report-notes.js";

/**
 * Makes the part of an evaluation that the notes read.
 * @param more - Fields that differ.
 * @returns An evaluation of one harness and one subject, cast for the notes.
 */
const evaluation = (more: Record<string, unknown>) =>
  ({
    harnesses: ["claude-code"],
    subjects: [{ label: "subject" }],
    applied: {
      "claude-code": [{ id: "alpha" }, { id: "bravo" }],
    },
    reps: 1,
    cases: [],
    records: [],
    skippedChecks: [],
    notApplicable: [],
    notRun: [],
    partial: null,
    ...more,
  }) as never;

const BUDGET = "--max-cost";
const notRun = [
  { harness: "claude-code", caseId: "bravo", subject: "subject", rep: 1 },
];

test.each([
  ["budget", BUDGET],
  ["duration", "--max-duration"],
])("a stop by %s names %s and no other flag", (reason, flag) => {
  const text = noteSections(evaluation({ partial: { reason }, notRun })).join(
    "\n",
  );
  expect(text).toContain(`The command stopped at ${flag} (${reason}).`);
  const other = flag === BUDGET ? "--max-duration" : "--max-cost";
  expect(text).not.toContain(other);
});

test.each(["interrupted", "running", "error"])(
  "a partial of %s is not a stop by a limit and has no section",
  (reason) => {
    const text = noteSections(evaluation({ partial: { reason }, notRun }));
    expect(text.join("\n")).not.toContain("Stopped early");
  },
);

test("the retried-runs total has a lower bound when some failed attempts reported no cost", () => {
  const attempts = (costs: (number | null)[]) =>
    costs.map((costUsd) => ({ error: "e", costUsd, durationMs: 1000 }));
  const lines = (costs: (number | null)[]) =>
    noteSections(evaluation({ records: [{ attempts: attempts(costs) }] })).join(
      "\n",
    );
  expect(lines([0.5, 0.25])).toContain("in total");
  expect(lines([0.5, 0.25])).toContain(", $0.7500 in total");
  expect(lines([0.5, null])).toContain(", ≥$0.5000 in total");
  expect(lines([null])).not.toContain("$");
});
