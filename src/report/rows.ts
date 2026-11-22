import type { Results } from "../evaluate.js";
import { invalidReason } from "../run.js";
import type { CaseScore, SuiteScore } from "../score.js";
import { formatScore, missesBar } from "../score.js";

/** How a case went for one harness and subject. */
type CaseStatus = "pass" | "below" | "invalid" | "not-applicable" | "not-run";

/** One case, for one harness and subject: what the JSON, JUnit and HTML reports list. */
export interface CaseRow {
  harness: string;
  /** The subject's label: "subject", "a" or "b". */
  subject: string;
  caseId: string;
  /** The case score; null when no run has a score, and for a case that is not applicable. */
  score: number | null;
  validRuns: number;
  plannedRuns: number;
  /**
   * "invalid" when any run of the case is invalid, whatever the score. Else "below" when the subject under test (the
   * last one) is under the case's `minScore`. Else "not-run" when a run of the plan did not run or no run has a score.
   * Else "pass". "not-applicable" has no runs.
   */
  status: CaseStatus;
  /** Why the status is not "pass", in words. Empty for a pass. */
  reason: string;
}

/** What the status of one case is decided from. */
interface Slot {
  results: Results;
  suite: SuiteScore;
  scored: CaseScore;
  label: string;
}

/**
 * Words why the runs of a case are invalid.
 * @param slot - The harness, case and subject.
 * @returns One entry for each invalid run that ran. A run whose graders a limit skipped did not run and is left out.
 */
function invalidReasons(slot: Slot): string[] {
  return slot.results.records.flatMap((record) => {
    const reason = invalidReason(record);
    const mine =
      record.harness === slot.suite.harness &&
      record.caseId === slot.scored.id &&
      record.subject === slot.label;
    return !mine || reason === null || record.skippedGraders === true
      ? []
      : [`rep ${String(record.rep)}: ${reason}`];
  });
}

/**
 * Decides how one case went for one harness and subject.
 * @param slot - The harness, case and subject.
 * @returns The status and the words for it.
 */
function statusOf(slot: Slot): Pick<CaseRow, "status" | "reason"> {
  const { results, suite, scored, label } = slot;
  const invalid = invalidReasons(slot);
  const score = scored.scores[label] ?? null;
  if (invalid.length > 0) {
    return { status: "invalid", reason: invalid.join("; ") };
  }
  if (label === results.subjects.at(-1)?.label && score !== null) {
    if (missesBar(score, scored.minScore)) {
      const shown = formatScore(score);
      return {
        status: "below",
        reason: `score ${shown} is below the case's minScore ${formatScore(scored.minScore ?? null)}`,
      };
    }
  }
  const missing = results.notRun.some(
    (run) =>
      run.harness === suite.harness &&
      run.caseId === scored.id &&
      run.subject === label,
  );
  return missing || score === null
    ? { status: "not-run", reason: "not run" }
    : { status: "pass", reason: "" };
}

/**
 * Lists every case for every harness and subject.
 * @param results - What `evaluate` wrote to `results.json`.
 * @returns One row for each harness, subject and case: the applicable cases in suite order, then the cases that are not
 *   applicable.
 */
export function caseRows(results: Results): CaseRow[] {
  return results.suites.flatMap((suite) =>
    results.subjects.flatMap(({ label }) => [
      ...suite.cases.map((scored): CaseRow => ({
        harness: suite.harness,
        subject: label,
        caseId: scored.id,
        score: scored.scores[label] ?? null,
        validRuns: scored.runs[label]?.valid ?? 0,
        plannedRuns: scored.runs[label]?.planned ?? 0,
        ...statusOf({ results, suite, scored, label }),
      })),
      ...results.notApplicable
        .filter((entry) => entry.harness === suite.harness)
        .map((entry): CaseRow => ({
          harness: suite.harness,
          subject: label,
          caseId: entry.caseId,
          score: null,
          validRuns: 0,
          plannedRuns: 0,
          status: "not-applicable",
          reason: entry.reason,
        })),
    ]),
  );
}
