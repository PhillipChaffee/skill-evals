import type { Evaluation } from "../evaluate.js";
import { FAILING_CEILING, NON_DISCRIMINATING_FLOOR } from "../comparison.js";
import { CONFIDENCE, RESAMPLES } from "../stats.js";
import { footnote } from "./delta.js";
import type { Summary } from "../summary.js";
import { summaryOf } from "../summary.js";
import type { CaseRow } from "./rows.js";
import { caseRows } from "./rows.js";

const INDENT = "\t";

/** What `report.json` holds. */
export interface JsonReport {
  schemaVersion: 1;
  /** The object `summary.json` holds. */
  summary: Summary;
  /**
   * How the deltas of `cases` were made; null with one subject. `footnote` is the sentence the other formats print.
   * `discrimination` holds the two thresholds of the labels, and is null unless a subject is "none".
   */
  method: {
    interval: "percentile bootstrap";
    confidence: number;
    resamples: number;
    seed: number;
    stratified: true;
    noiseFile: string | null;
    discrimination: {
      nonDiscriminatingFloor: number;
      failingCeiling: number;
    } | null;
    footnote: string;
  } | null;
  /**
   * One entry for each harness, subject and case. `delta`, `low`, `high`, `verdict` and `discrimination` are the
   * case's, so the entries of A and of B hold the same values; all are null with one subject.
   */
  cases: Pick<
    CaseRow,
    | "harness"
    | "subject"
    | "caseId"
    | "score"
    | "validRuns"
    | "plannedRuns"
    | "delta"
    | "low"
    | "high"
    | "verdict"
    | "discrimination"
    | "status"
    | "tolerated"
  >[];
}

/**
 * Describes how the deltas of an evaluation were made.
 * @param evaluation - What `evaluate` returned.
 * @returns The method, the seed, the noise file and the footnote; null with one subject.
 */
function methodOf(evaluation: Evaluation): JsonReport["method"] {
  const note = footnote(evaluation);
  if (note === null) return null;
  const hasNone =
    evaluation.subjects.filter(({ kind }) => kind === "none").length === 1;
  return {
    interval: "percentile bootstrap",
    confidence: CONFIDENCE,
    resamples: RESAMPLES,
    seed: evaluation.seed,
    stratified: true,
    noiseFile: evaluation.noiseFile,
    discrimination: hasNone
      ? {
          nonDiscriminatingFloor: NON_DISCRIMINATING_FLOOR,
          failingCeiling: FAILING_CEILING,
        }
      : null,
    footnote: note,
  };
}

/**
 * Builds the JSON report of an evaluation.
 * @param evaluation - What `evaluate` returned.
 * @returns The report: the summary, which is what `summary.json` holds, and one entry for each case.
 */
function jsonReport(evaluation: Evaluation): JsonReport {
  return {
    schemaVersion: 1,
    summary: summaryOf(evaluation, evaluation.exit),
    method: methodOf(evaluation),
    cases: caseRows(evaluation).map(
      ({
        harness,
        subject,
        caseId,
        score,
        validRuns,
        plannedRuns,
        delta,
        low,
        high,
        verdict,
        discrimination,
        status,
        tolerated,
      }) => ({
        harness,
        subject,
        caseId,
        score,
        validRuns,
        plannedRuns,
        delta,
        low,
        high,
        verdict,
        discrimination,
        status,
        tolerated,
      }),
    ),
  };
}

/**
 * Renders the JSON report of an evaluation.
 * @param evaluation - What `evaluate` returned.
 * @returns The text of `report.json`.
 */
export const renderJson = (evaluation: Evaluation): string =>
  `${JSON.stringify(jsonReport(evaluation), null, INDENT)}\n`;
