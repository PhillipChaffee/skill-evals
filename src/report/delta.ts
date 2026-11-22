import type { CaseDelta, HarnessDelta } from "../comparison.js";
import {
  FAILING_CEILING,
  MIN_RUNS_FOR_SUITE,
  MIN_RUNS_FOR_VERDICT,
  NON_DISCRIMINATING_FLOOR,
} from "../comparison.js";
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
 * @param counts - How many runs stand behind it; when some planned runs are unscored the cell says how many it is over.
 * @param counts.valid - The valid runs.
 * @param counts.planned - The runs the plan holds.
 * @returns A whole percentage such as "33%", or "33% (of 2)" when some runs are unscored; "n/a" for none.
 */
export function flakeText(
  rate: number | null,
  counts?: { valid: number; planned: number },
): string {
  if (rate === null) return "n/a";
  const over =
    counts !== undefined && counts.valid < counts.planned
      ? ` (of ${String(counts.valid)})`
      : "";
  return `${String(Math.round(rate * PERCENT))}%${over}`;
}

/**
 * Renders the verdict of a case for a table cell.
 * @param delta - The case's comparison entry; undefined for a case that was not compared.
 * @returns "helped (+0.12, 95% −0.03..+0.27)"; "too few runs (A n=3, B n=3)" below `MIN_RUNS_FOR_VERDICT`; "n/a" when
 *   a side has no valid run.
 */
export function verdictCell(delta: CaseDelta | undefined): string {
  if (delta?.verdict === "too few runs") {
    return `too few runs (A n=${String(delta.n.a)}, B n=${String(delta.n.b)})`;
  }
  return delta === undefined ? "n/a" : verdictText(delta);
}

/**
 * Renders the verdict of a suite for a table cell or a line.
 * @param suite - The suite's comparison entry.
 * @returns As `verdictCell`, with the fewest runs on a side when there are too few.
 */
export const suiteVerdictCell = (suite: HarnessDelta["suite"]): string =>
  suite.verdict === "too few runs"
    ? `too few runs (fewest on a side: n=${String(suite.fewest)})`
    : verdictText(suite);

/**
 * Lists the cases that a noise file leaves out.
 * @param evaluation - What `evaluate` returned.
 * @returns The ids of the compared cases of the calibrated harness that the noise file does not list; none without a
 *   noise file.
 */
function unlisted(evaluation: Evaluation): string[] {
  const { noiseMeta } = evaluation;
  if (noiseMeta === null) return [];
  return [
    ...new Set(
      (evaluation.comparison?.harnesses ?? [])
        .filter(({ harness }) => harness === noiseMeta.harness)
        .flatMap(({ cases }) =>
          cases.filter((one) => one.noise === null).map((one) => one.id),
        ),
    ),
  ];
}

/**
 * Words what the noise file does and does not cover.
 * @param evaluation - What `evaluate` returned.
 * @returns A sentence or two; the one that says no file was given when there is none.
 */
function noiseNote(evaluation: Evaluation): string {
  const { noiseFile, noiseMeta } = evaluation;
  if (noiseFile === null || noiseMeta === null) {
    return "No noise file was given, so the interval alone decides.";
  }
  const others = evaluation.harnesses.filter((id) => id !== noiseMeta.harness);
  const missing = unlisted(evaluation);
  const compared = (evaluation.comparison?.harnesses ?? []).flatMap(
    ({ cases }) => cases.map((one) => one.id),
  );
  return [
    `Noise file: ${noiseFile}, calibrated on ${noiseMeta.harness} at ${String(noiseMeta.reps)} reps; a case is judged against its perCase p95AbsDelta there and the suite against suite.p95AbsDelta.`,
    ...(others.length === 0
      ? []
      : [
          `It is not applied to ${others.join(", ")}: other harnesses have their own noise.`,
        ]),
    ...(noiseMeta.reps === evaluation.reps
      ? []
      : [
          `This run uses ${String(evaluation.reps)} reps, not ${String(noiseMeta.reps)}, so the noise bound may not fit.`,
        ]),
    ...(compared.length > 0 &&
    !compared.some((id) => noiseMeta.caseIds.includes(id))
      ? [
          "No case of this suite is in the noise file: it was calibrated on another suite.",
        ]
      : []),
    ...(missing.length === 0
      ? []
      : [
          `Not in the noise file, so judged by the interval alone: ${missing.join(", ")}.`,
        ]),
  ].join(" ");
}

/**
 * Words the method behind every verdict, in one footnote.
 * @param evaluation - What `evaluate` returned.
 * @returns The footnote: the method, the number of resamples, the seed, the stratification, the runs a verdict needs
 *   and the noise file used; null for one subject, which has no delta.
 */
export function footnote(evaluation: Evaluation): string | null {
  if (evaluation.comparison === null) return null;
  const orientation =
    evaluation.subjects[1]?.kind === "none"
      ? " Verdicts are B minus A; with B none, hurt means A scored higher."
      : "";
  return `Verdicts: percentile bootstrap over run scores (valid runs only), ${String(CONFIDENCE * PERCENT)}% interval, ${String(RESAMPLES)} resamples, seed ${String(evaluation.seed)}, resampled within each case (stratified); the suite delta is the mean of the case deltas by weight over the cases scored on both subjects. A case needs at least ${String(MIN_RUNS_FOR_VERDICT)} valid runs on each side (MIN_RUNS_FOR_VERDICT) and the suite at least ${String(MIN_RUNS_FOR_SUITE)} in every case it covers; below that the verdict is "too few runs". Percentile intervals under-cover at small n, so an interval from few runs is narrower than its 95% says. A delta reads "within noise" when its interval holds 0 or it is no larger than the noise bound.${orientation} ${noiseNote(evaluation)}`;
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
  /** The valid runs behind the rate, and the runs planned. */
  counts: { valid: number; planned: number };
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
          counts: {
            valid: valid.length,
            planned:
              evaluation.suites
                .find((suite) => suite.harness === harness)
                ?.cases.find((one) => one.id === caseDef.id)?.runs[label]
                ?.planned ?? 0,
          },
        }));
      }),
    ),
  );
}
