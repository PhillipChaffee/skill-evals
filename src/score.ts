// Scores are numbers from 0 to 1, or null for "no score".
// - check score: what one check gave one run
// - run score: the weighted mean of the run's check scores; an invalid run has none
// - case score: the mean of the run scores over the reps, for one harness and one subject
// - suite score: the weighted mean of the case scores, for one harness and one subject

/** How many runs stand behind a score: the valid ones and the ones the plan holds. */
export interface RunCount {
  /** Runs with a score. An invalid run has none. */
  valid: number;
  /** Runs the plan holds, finished or not. */
  planned: number;
}

/** A case's scores, keyed by subject label. */
export interface CaseScore {
  id: string;
  weight: number;
  minScore?: number | undefined;
  scores: Record<string, number | null>;
  /** The runs behind each score, by subject label. */
  runs: Record<string, RunCount>;
}

/** One harness's case scores, and its suite score keyed by subject label. */
export interface SuiteScore {
  harness: string;
  cases: CaseScore[];
  suite: Record<string, number | null>;
  /** How many cases apply to the harness. Only these are in `cases` and in the suite score. */
  applicable: number;
  /** How many cases the suite has, applicable or not. */
  total: number;
  /** The runs behind the suite score, by subject label: the sum over its applicable cases. */
  runs: Record<string, RunCount>;
}

/** The part of a run record that scoring reads. */
interface ScoredRun {
  harness: string;
  caseId: string;
  subject: string;
  score: number | null;
}

/** The part of a case that scoring reads. */
interface WeightedCase {
  id: string;
  weight: number;
  minScore?: number | undefined;
  /** The runs planned for each subject; the run's `reps` when absent. */
  reps?: number | undefined;
}

// Absorbs float error in a mean, so three runs at 0.8 reach a bar of 0.8.
const EPSILON = 1e-9;
const SCORE_DECIMALS = 2;
// A comparison needs two harnesses.
const MIN_COMPARED = 2;

/**
 * Tells whether a value read from a file or a model is usable as a score.
 * @param value - Anything; a numeric string is not a score.
 * @returns True for a finite number from 0 to 1, both ends included.
 */
export const isUnitScore = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

/**
 * Renders a score the way every report line shows it.
 * @param score - A score, or null for a missing one.
 * @returns Two decimals, or "n/a" for null.
 */
export const formatScore = (score: number | null): string =>
  score === null ? "n/a" : score.toFixed(SCORE_DECIMALS);

/**
 * Averages scores by weight, refusing to average around a gap.
 * @param items - Scores with the weight each one counts for.
 * @returns Null when there is nothing to average or any item has no score.
 */
export function weightedMean(
  items: { score: number | null; weight: number }[],
): number | null {
  let total = 0;
  let weighted = 0;
  for (const { score, weight } of items) {
    if (score === null) return null;
    total += weight;
    weighted += score * weight;
  }
  return items.length === 0 ? null : weighted / total;
}

const caseScore = (records: ScoredRun[]): number | null =>
  weightedMean(
    records
      .filter((record) => record.score !== null)
      .map((record) => ({ score: record.score, weight: 1 })),
  );

const countsOf = (
  labels: readonly string[],
  count: (label: string) => RunCount,
): Record<string, RunCount> =>
  Object.fromEntries(labels.map((label) => [label, count(label)]));

const sum = (
  scored: { runs: Record<string, RunCount> }[],
  label: string,
  field: keyof RunCount,
): number =>
  scored.reduce((total, one) => total + (one.runs[label]?.[field] ?? 0), 0);

/**
 * Scores every case and the whole suite, once for each harness and subject label.
 * @param run - What ran.
 * @param run.harnesses - The ids of the harnesses, in report order.
 * @param run.cases - The cases, in report order.
 * @param run.records - Every run; one whose score is null does not count toward its case.
 * @param run.labels - The subject labels to score.
 * @param run.applicable - For each harness id, the ids of the cases that apply to it. Only those are scored, and the
 *   others count only in `total`. Default: every case on every harness.
 * @param run.reps - The runs planned for each subject and case, which a case's own `reps` replaces. Default: the number
 *   of records of the case and subject.
 * @returns One entry for each harness. A case with no valid run has the score null, and so has its suite; so has a
 *   harness to which no case applies.
 */
export function scoreSuites(run: {
  harnesses: string[];
  cases: WeightedCase[];
  records: ScoredRun[];
  labels: readonly string[];
  applicable?: Record<string, string[]>;
  reps?: number;
}): SuiteScore[] {
  const perLabel = (
    score: (label: string) => number | null,
  ): Record<string, number | null> =>
    Object.fromEntries(run.labels.map((label) => [label, score(label)]));
  return run.harnesses.map((harness) => {
    const mine = run.records.filter((record) => record.harness === harness);
    const ids = run.applicable?.[harness];
    const scored = run.cases
      .filter(({ id }) => ids?.includes(id) ?? true)
      .map(({ id, weight, minScore, reps }) => {
        const of = (label: string): ScoredRun[] =>
          mine.filter((r) => r.caseId === id && r.subject === label);
        return {
          id,
          weight,
          minScore,
          scores: perLabel((label) => caseScore(of(label))),
          runs: countsOf(run.labels, (label) => ({
            valid: of(label).filter((r) => r.score !== null).length,
            planned: reps ?? run.reps ?? of(label).length,
          })),
        };
      });
    return {
      harness,
      cases: scored,
      applicable: scored.length,
      total: run.cases.length,
      runs: countsOf(run.labels, (label) => ({
        valid: sum(scored, label, "valid"),
        planned: sum(scored, label, "planned"),
      })),
      suite: perLabel((label) =>
        weightedMean(
          scored.map((c) => ({
            score: c.scores[label] ?? null,
            weight: c.weight,
          })),
        ),
      ),
    };
  });
}

/**
 * Tells whether a score is below its pass bar.
 * @param score - The score; null for none.
 * @param bar - The bar; undefined for none.
 * @returns True when there is a bar and the score is under it. A missing score reaches no bar.
 */
export const missesBar = (
  score: number | null,
  bar: number | undefined,
): boolean => bar !== undefined && (score === null || score < bar - EPSILON);

const missed = (score: number | null, bar: number | undefined): number[] =>
  bar !== undefined && missesBar(score, bar) ? [bar] : [];

/**
 * Words a run count for the end of a line about a score.
 * @param runs - The counts by subject label.
 * @param label - The subject the score is of.
 * @returns "(2 of 3 runs)".
 */
const counted = (runs: Record<string, RunCount>, label: string): string =>
  `(${String(runs[label]?.valid ?? 0)} of ${String(runs[label]?.planned ?? 0)} runs)`;

/**
 * Lists the pass bars that the subject under test did not reach.
 * @param suites - The scores of every harness.
 * @param label - The label of the subject the bars apply to.
 * @param minScore - The bar for the suite score; each case carries its own.
 * @returns One line for each missed bar. A missing score does not reach a bar.
 */
export function failedBars(
  suites: SuiteScore[],
  label: string,
  minScore: number | undefined,
): string[] {
  return suites.flatMap(({ harness, cases, suite, applicable, runs }) => {
    // A harness to which no case applies has no score to measure against a bar.
    if (applicable === 0) return [];
    const suiteScore = suite[label] ?? null;
    return [
      ...missed(suiteScore, minScore).map(
        (bar) =>
          `${harness}: suite score ${formatScore(suiteScore)} ${counted(runs, label)} does not reach --min-score ${formatScore(bar)}`,
      ),
      ...cases.flatMap((c) => {
        const score = c.scores[label] ?? null;
        return missed(score, c.minScore).map(
          (bar) =>
            `${harness}: case \`${c.id}\` score ${formatScore(score)} ${counted(c.runs, label)} does not reach its minScore ${formatScore(bar)}`,
        );
      }),
    ];
  });
}

/** The score over the cases that apply to every harness that has any, for each harness and subject label. */
export interface CommonSet {
  /** The ids of the cases that apply to all of those harnesses. */
  cases: string[];
  suite: Record<string, Record<string, number | null>>;
  /** The runs behind each of those scores, by harness and subject label. */
  runs: Record<string, Record<string, RunCount>>;
}

/**
 * Scores the cases that apply to every harness that has an applicable case, the only scores that compare harnesses.
 * @param run - The same inputs as `scoreSuites`; `applicable` is required.
 * @param run.harnesses - The ids of the harnesses, in report order.
 * @param run.cases - The cases, in report order.
 * @param run.records - Every run.
 * @param run.labels - The subject labels to score.
 * @param run.applicable - For each harness id, the ids of the cases that apply to it.
 * @returns The common cases and each harness's suite score over them. Null unless two harnesses have an applicable
 *   case, because a harness with none is left out.
 */
export function commonSet(run: {
  harnesses: string[];
  cases: WeightedCase[];
  records: ScoredRun[];
  labels: readonly string[];
  applicable: Record<string, string[]>;
}): CommonSet | null {
  const sets = run.harnesses.flatMap((id) => {
    const ids = run.applicable[id] ?? [];
    return ids.length > 0 ? [{ id, ids }] : [];
  });
  if (sets.length < MIN_COMPARED) return null;
  const common = run.cases
    .map(({ id }) => id)
    .filter((id) => sets.every(({ ids }) => ids.includes(id)));
  const scored = scoreSuites({
    ...run,
    harnesses: sets.map(({ id }) => id),
    applicable: Object.fromEntries(sets.map(({ id }) => [id, common])),
  });
  return {
    cases: common,
    suite: Object.fromEntries(
      scored.map(({ harness, suite }) => [harness, suite]),
    ),
    runs: Object.fromEntries(
      scored.map(({ harness, runs }) => [harness, runs]),
    ),
  };
}
