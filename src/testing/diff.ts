import type { Results } from "../evaluate.js";
import type { RunRecord } from "../run.js";

const HALF = 0.5;

/**
 * Makes one check result of a synthetic record.
 * @param score - What the check scored; null for no score.
 * @returns A check result for the synthetic record.
 */
export const result = (score: number | null) => ({
  type: "output_contains",
  text: "x",
  weight: 1,
  score,
});

/**
 * Makes a synthetic record of the case `c` on the harness `h`.
 * @param checks - The score of each check.
 * @param more - Fields to set besides.
 * @returns A run record with those checks.
 */
export function record(
  checks: (number | null)[],
  more: Partial<RunRecord> = {},
): RunRecord {
  const scores = checks.filter((one) => one !== null);
  return {
    harness: "h",
    subject: "subject",
    caseId: "c",
    rep: 1,
    ok: true,
    error: null,
    finalText: "",
    isolated: false,
    unexpected: [],
    reportMissing: false,
    subjectLoaded: null,
    judgeProblem: null,
    checks: checks.map(result),
    score: scores.length === checks.length ? HALF : null,
    durationMs: 1000,
    tokens: null,
    costUsd: 0.5,
    judge: null,
    decision: null,
    ...more,
  } as unknown as RunRecord;
}

/**
 * Makes synthetic results of the harness `h`.
 * @param records - The runs; the cases are the ones they name.
 * @param more - Fields to set besides.
 * @returns Results with those runs.
 */
export function results(
  records: RunRecord[],
  more: Partial<Results> = {},
): Results {
  const ids = [...new Set(records.map((one) => one.caseId))];
  return {
    schemaVersion: 1,
    subjects: [{ label: "subject" }],
    harnesses: ["h"],
    meta: {
      toolVersion: "1",
      harnessVersions: {},
      models: { agent: "m", judge: null, decision: null },
      subjects: [],
      caseHashes: {
        h: Object.fromEntries(ids.map((id) => [id, `hash-${id}`])),
      },
      isolated: false,
    },
    suites: [
      {
        harness: "h",
        suite: { subject: 0.5 },
        cases: ids.map((id) => ({
          id,
          weight: 1,
          scores: { subject: 0.5 },
          runs: { subject: { valid: 1, planned: 1 } },
        })),
      },
    ],
    records,
    ...more,
  } as unknown as Results;
}
