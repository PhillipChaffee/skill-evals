import type { Evaluation } from "../evaluate.js";
import { formatScore } from "../score.js";
import type { CaseRow } from "./rows.js";
import { caseRows } from "./rows.js";
import { escapeXml } from "./xml.js";

const MS_PER_SECOND = 1000;
const TIME_DECIMALS = 3;

/**
 * Seconds of the runs of one case, one harness and one subject, which a JUnit reader shows as the test's time.
 * @param evaluation - What `evaluate` returned.
 * @param row - The case.
 * @returns The seconds, summed over the runs of the case that finished.
 */
function secondsOf(evaluation: Evaluation, row: CaseRow): string {
  const ms = evaluation.records
    .filter(
      (record) =>
        record.harness === row.harness &&
        record.subject === row.subject &&
        record.caseId === row.caseId,
    )
    .reduce((sum, record) => sum + record.durationMs, 0);
  return (ms / MS_PER_SECOND).toFixed(TIME_DECIMALS);
}

/**
 * Writes the problem element of a case that did not pass.
 * @param row - The case.
 * @returns A `failure` for a case below its bar, an `error` for one with an invalid run, a `skipped` for one that is
 *   not applicable or did not run, and nothing for a pass.
 */
function outcomeOf(row: CaseRow): string {
  const message = escapeXml(
    row.status === "below"
      ? `${row.reason} (${String(row.validRuns)} of ${String(row.plannedRuns)} runs)`
      : row.reason,
  );
  switch (row.status) {
    case "below":
      return `<failure message="${message}"/>`;
    case "invalid":
      return `<error message="${message}"/>`;
    case "not-applicable":
    case "not-run":
      return `<skipped message="${message}"/>`;
    case "pass":
      return "";
  }
}

/**
 * Counts the cases of each kind.
 * @param rows - The cases of one suite.
 * @returns The attributes that a `testsuite` carries.
 */
const countsOf = (rows: CaseRow[]): string => {
  const count = (...statuses: CaseRow["status"][]): number =>
    rows.filter((row) => statuses.includes(row.status)).length;
  return `tests="${String(rows.length)}" failures="${String(count("below"))}" errors="${String(count("invalid"))}" skipped="${String(count("not-applicable", "not-run"))}"`;
};

/**
 * Renders an evaluation as a JUnit XML report, the format that CI systems read.
 * @param evaluation - What `evaluate` returned.
 * @returns One `testsuite` for each harness and subject, and one `testcase` for each case. A case below its bar is a
 *   `failure`, a case with an invalid run an `error`, and a case that is not applicable, or did not run, `skipped`. A
 *   passing case has its score and run count in `system-out`.
 */
export function renderJunit(evaluation: Evaluation): string {
  const rows = caseRows(evaluation);
  const keys = [
    ...new Set(rows.map((row) => `${row.harness}\u0000${row.subject}`)),
  ];
  const suites = keys.map((key) => {
    const mine = rows.filter(
      (row) => `${row.harness}\u0000${row.subject}` === key,
    );
    const [first] = mine;
    const name = escapeXml(`${first?.harness ?? ""} ${first?.subject ?? ""}`);
    const cases = mine.map((row) => {
      const outcome = outcomeOf(row);
      const out =
        row.score === null
          ? ""
          : `<system-out>${escapeXml(`score ${formatScore(row.score)} (${String(row.validRuns)} of ${String(row.plannedRuns)} runs)`)}</system-out>`;
      return `    <testcase classname="${name}" name="${escapeXml(row.caseId)}" time="${secondsOf(evaluation, row)}">${outcome}${out}</testcase>`;
    });
    return `  <testsuite name="${name}" ${countsOf(mine)}>\n${cases.join("\n")}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="skill-evals" ${countsOf(rows)}>\n${suites.join("\n")}\n</testsuites>\n`;
}
