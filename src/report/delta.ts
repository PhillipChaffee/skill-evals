import type { CaseDelta } from "../comparison.js";
import { FAILING_CEILING, NON_DISCRIMINATING_FLOOR } from "../comparison.js";
import { verdictText } from "../delta-format.js";
import { describeCheck } from "../checks/index.js";
import type { Evaluation } from "../evaluate.js";
import { invalidReason } from "../run.js";
import type { RunRecord } from "../run.js";
import { CONFIDENCE, RESAMPLES } from "../stats.js";

/** A rep passes a check when the check's score is at least this. A flake is a rep that disagrees with the majority. */
export const PASS_AT = 0.5;
const PERCENT = 100;

/**
 * Measures how much one check flips between reps.
 * @param runs - The valid runs of one case and subject.
 * @param index - The check's place among the case's checks.
 * @returns The share of the valid reps that disagree with the majority outcome, where a rep passes at a check score of
 *   `PASS_AT` or more; an even split is 0.5. Null when no run has a score for the check.
 */
export function flakeRate(runs: RunRecord[], index: number): number | null {
  const scores = runs.flatMap((run) => run.checks[index]?.score ?? []);
  if (scores.length === 0) return null;
  const passed = scores.filter((score) => score >= PASS_AT).length;
  return Math.min(passed, scores.length - passed) / scores.length;
}

/**
 * Renders a flake rate.
 * @param rate - What `flakeRate` returned.
 * @returns A whole percentage such as "33%"; "n/a" for none.
 */
export const flakeText = (rate: number | null): string =>
  rate === null ? "n/a" : `${String(Math.round(rate * PERCENT))}%`;

/**
 * Renders the verdict of a case for a table cell.
 * @param delta - The case's comparison entry; undefined for a case that was not compared.
 * @returns "helped (+0.12, 95% −0.03..+0.27)"; "n/a" when a side has no valid run.
 */
export const verdictCell = (delta: CaseDelta | undefined): string =>
  delta === undefined ? "n/a" : verdictText(delta);

/**
 * Lists the cases that a noise file leaves out.
 * @param evaluation - What `evaluate` returned.
 * @returns The ids of the compared cases that the noise file does not list; none without a noise file.
 */
function unlisted(evaluation: Evaluation): string[] {
  if (evaluation.noiseFile === null) return [];
  return [
    ...new Set(
      (evaluation.comparison?.harnesses ?? []).flatMap(({ cases }) =>
        cases.filter((one) => one.noise === null).map((one) => one.id),
      ),
    ),
  ];
}

/**
 * Words the method behind every verdict, in one footnote.
 * @param evaluation - What `evaluate` returned.
 * @returns The footnote: the method, the number of resamples, the seed, the stratification and the noise file used;
 *   null for one subject, which has no delta.
 */
export function footnote(evaluation: Evaluation): string | null {
  if (evaluation.comparison === null) return null;
  const missing = unlisted(evaluation);
  const noise =
    evaluation.noiseFile === null
      ? "No noise file was given, so the interval alone decides."
      : `Noise file: ${evaluation.noiseFile}; a case is judged against its maxAbsDelta there and the suite against its p95AbsDelta.${missing.length === 0 ? "" : ` Not in the noise file, so judged by the interval alone: ${missing.join(", ")}.`}`;
  return `Verdicts: percentile bootstrap over run scores (valid runs only), ${String(CONFIDENCE * PERCENT)}% interval, ${String(RESAMPLES)} resamples, seed ${String(evaluation.seed)}, resampled within each case (stratified); the suite delta is the mean of the case deltas by weight over the cases scored on both subjects. A delta reads "within noise" when its interval holds 0 or it is no larger than the noise bound. ${noise}`;
}

/** One case of the discrimination table. */
export interface DiscriminationRow {
  harness: string;
  caseId: string;
  /** The mean score of the none arm; null for no valid run. */
  none: number | null;
  /** The mean score of the arm with the subject; null for no valid run. */
  subject: number | null;
  label: NonNullable<CaseDelta["discrimination"]>;
}

/**
 * Lists the discrimination of every case that has one: only when a subject is "none", and never for a guard case.
 * @param evaluation - What `evaluate` returned.
 * @returns One row for each such case.
 */
export function discriminationRows(
  evaluation: Evaluation,
): DiscriminationRow[] {
  const noneIsA = evaluation.subjects[0]?.kind === "none";
  return (evaluation.comparison?.harnesses ?? []).flatMap(
    ({ harness, cases }) =>
      cases.flatMap((one) =>
        one.discrimination === null
          ? []
          : [
              {
                harness,
                caseId: one.id,
                none: noneIsA ? one.a : one.b,
                subject: noneIsA ? one.b : one.a,
                label: one.discrimination,
              },
            ],
      ),
  );
}

/**
 * Words what the discrimination labels mean, with the two thresholds that decide them.
 * @returns One paragraph; the labels are given in the order they are tried.
 */
export const discriminationRule = (): string =>
  `Each case gets the first label that fits: non-discriminating when the none arm scores at least ${String(NON_DISCRIMINATING_FLOOR)} (NON_DISCRIMINATING_FLOOR), failing with the subject when the subject scores below ${String(FAILING_CEILING)} (FAILING_CEILING), discriminating when the verdict is that the subject helped, else no evidence. Guard cases are left out.`;

/** How much one check flipped between the reps of one case, for one harness and subject. */
export interface FlakeRow {
  harness: string;
  subject: string;
  caseId: string;
  check: string;
  /** What `flakeRate` returned. */
  rate: number | null;
}

/**
 * Measures the flake of every check of every case.
 * @param evaluation - What `evaluate` returned.
 * @returns One row for each harness, subject, case and check, in report order.
 */
export function flakeRows(evaluation: Evaluation): FlakeRow[] {
  return evaluation.harnesses.flatMap((harness) =>
    (evaluation.applied[harness] ?? []).flatMap((caseDef) =>
      evaluation.subjects.flatMap(({ label }) => {
        const valid = evaluation.records.filter(
          (record) =>
            record.harness === harness &&
            record.caseId === caseDef.id &&
            record.subject === label &&
            invalidReason(record) === null,
        );
        return caseDef.checks.map((check, index) => ({
          harness,
          subject: label,
          caseId: caseDef.id,
          check: describeCheck(check),
          rate: flakeRate(valid, index),
        }));
      }),
    ),
  );
}
