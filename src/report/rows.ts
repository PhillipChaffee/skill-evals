import type { CaseDelta, Discrimination } from "../comparison.js";
import { formatDelta } from "../delta-format.js";
import type { DeltaVerdict } from "../stats.js";
import type { Results } from "../evaluate.js";
import { overBudget } from "../exit-codes.js";
import { invalidReason } from "../run.js";
import type { CaseScore, SuiteScore } from "../score.js";
import { formatScore, missesBar } from "../score.js";

/** How a case went for one harness and subject. */
type CaseStatus = "pass" | "below" | "invalid" | "not-applicable" | "not-run";

/** A status and the words for it. */
interface Outcome {
  status: CaseStatus;
  /** Why the status is not "pass", in words. Empty for a pass. */
  reason: string;
}

/** One case, for one harness and subject: what the JSON, JUnit and HTML reports list. */
export interface CaseRow extends Outcome {
  harness: string;
  /** The subject's label: "subject", "a" or "b". */
  subject: string;
  caseId: string;
  /** The case score; null when no run has a score, and for a case that is not applicable. */
  score: number | null;
  validRuns: number;
  plannedRuns: number;
  /** B minus A for the case, the same on the rows of both subjects; null with one subject and when a side has no valid run. */
  delta: number | null;
  /** The ends of the 95% bootstrap interval of the delta; null with it. */
  low: number | null;
  high: number | null;
  /** "helped", "hurt" or "within noise"; null with the delta. */
  verdict: DeltaVerdict | null;
  /** Null unless a subject is "none", and for a guard case. */
  discrimination: Discrimination | null;
  /**
   * "invalid" when any run of the case is invalid, whatever the score. Else "below" when the subject under test (the
   * last one) is under the case's `minScore`. Else "not-run" when a run of the plan did not run or no run has a score.
   * Else "pass". "not-applicable" has no runs.
   */
  status: CaseStatus;
  /**
   * True when the status is "invalid" but the case has a valid run and the invalid runs of the command are within
   * `--max-invalid`: the case still has a score that means something.
   */
  tolerated: boolean;
  /** How the case went by its score alone, as it would if no run were invalid; the same as the status when none is. */
  byScore: Outcome;
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

const NO_DELTA: CaseDelta = {
  id: "",
  guard: false,
  minDelta: null,
  n: { a: 0, b: 0 },
  a: null,
  b: null,
  delta: null,
  low: null,
  high: null,
  verdict: null,
  noise: null,
  discrimination: null,
};

/**
 * Finds the comparison entry of a case.
 * @param slot - The harness, case and subject.
 * @returns The case's delta, interval, verdict and discrimination; empty with one subject.
 */
function deltaOf(slot: Slot): CaseDelta {
  return (
    slot.results.comparison?.harnesses
      .find((one) => one.harness === slot.suite.harness)
      ?.cases.find((one) => one.id === slot.scored.id) ?? NO_DELTA
  );
}

/**
 * Decides how one case went by its score, leaving invalid runs out of account.
 * @param slot - The harness, case and subject.
 * @returns "below" when the subject under test is under the case's `minScore`, "not-run" when a run did not run or no run
 *   has a score, else "pass".
 */
function byScore(slot: Slot): Outcome {
  const { results, suite, scored, label } = slot;
  const score = scored.scores[label] ?? null;
  const mine = label === results.subjects.at(-1)?.label;
  const delta = deltaOf(slot);
  const reasons = [
    ...(mine && score !== null && missesBar(score, scored.minScore)
      ? [
          `score ${formatScore(score)} is below the case's minScore ${formatScore(scored.minScore ?? null)}`,
        ]
      : []),
    ...(mine &&
    delta.delta !== null &&
    delta.minDelta !== null &&
    missesBar(delta.delta, delta.minDelta)
      ? [
          `delta ${formatDelta(delta.delta)} is below the case's minDelta ${formatDelta(delta.minDelta)}`,
        ]
      : []),
  ];
  if (reasons.length > 0) {
    return { status: "below", reason: reasons.join("; ") };
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
 * Decides how one case went for one harness and subject.
 * @param slot - The harness, case and subject.
 * @returns The status, the words for it, whether invalid runs are tolerated, and the status by score alone.
 */
function statusOf(
  slot: Slot,
): Pick<CaseRow, "status" | "reason" | "tolerated" | "byScore"> {
  const invalid = invalidReasons(slot);
  const scoreOnly = byScore(slot);
  if (invalid.length === 0)
    return { ...scoreOnly, tolerated: false, byScore: scoreOnly };
  const valid = slot.scored.runs[slot.label]?.valid ?? 0;
  return {
    status: "invalid",
    reason: invalid.join("; "),
    tolerated: valid > 0 && !overBudget(slot.results, slot.results.maxInvalid),
    byScore: scoreOnly,
  };
}

/**
 * Takes the fields of a comparison entry that a row shows.
 * @param one - The entry.
 * @returns Its delta, interval, verdict and discrimination.
 */
const pick = (
  one: CaseDelta,
): Pick<CaseRow, "delta" | "low" | "high" | "verdict" | "discrimination"> => ({
  delta: one.delta,
  low: one.low,
  high: one.high,
  verdict: one.verdict,
  discrimination: one.discrimination,
});

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
        ...pick(deltaOf({ results, suite, scored, label })),
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
          ...pick(NO_DELTA),
          status: "not-applicable",
          reason: entry.reason,
          tolerated: false,
          byScore: { status: "not-applicable", reason: entry.reason },
        })),
    ]),
  );
}
