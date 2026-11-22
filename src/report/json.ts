import type { Evaluation } from "../evaluate.js";
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
  /** One entry for each harness, subject and case. */
  cases: Pick<
    CaseRow,
    | "harness"
    | "subject"
    | "caseId"
    | "score"
    | "validRuns"
    | "plannedRuns"
    | "status"
    | "tolerated"
  >[];
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
    cases: caseRows(evaluation).map(
      ({
        harness,
        subject,
        caseId,
        score,
        validRuns,
        plannedRuns,
        status,
        tolerated,
      }) => ({
        harness,
        subject,
        caseId,
        score,
        validRuns,
        plannedRuns,
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
