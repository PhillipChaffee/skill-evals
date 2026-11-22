import type { Case } from "./cases.js";
import type { NoiseFile } from "./noise.js";
import type { RunRecord } from "./run.js";
import { formatDelta } from "./delta-format.js";
import { missesBar } from "./score.js";
import type { DeltaVerdict, Interval, Stratum } from "./stats.js";
import {
  RESAMPLES,
  bootstrapDelta,
  bootstrapSuite,
  mean,
  seedFor,
  verdict,
} from "./stats.js";

/** The score under which a subject that scores this low is failing, whatever the none arm does. */
export const FAILING_CEILING = 0.5;
/** The score from which the none arm shows that the case does not need the skill. */
export const NON_DISCRIMINATING_FLOOR = 0.9;

/** A case needs this many valid runs on each side before its delta is judged: below it the verdict is "too few runs". */
export const MIN_RUNS_FOR_VERDICT = 5;
/** The suite delta needs this many valid runs on each side of every case it covers. */
export const MIN_RUNS_FOR_SUITE = 2;

/** What a case shows about whether the subject matters to it. */
export type Discrimination =
  | "non-discriminating"
  | "failing with the subject"
  | "discriminating"
  | "no evidence";

/** What a delta is, how sure it is, and what it was judged against. */
interface Judged {
  /** B minus A over the runs as they are; null when a side has no valid run. */
  delta: number | null;
  /** The ends of the 95% interval; null with the delta. */
  low: number | null;
  high: number | null;
  /** Null with the delta. */
  verdict: DeltaVerdict | null;
  /** The noise bound the verdict used; null when there is no noise file or it does not list this case. */
  noise: number | null;
}

/** One case of a comparison. */
export interface CaseDelta extends Judged {
  id: string;
  /** A guard case, which the discrimination table leaves out. */
  guard: boolean;
  /** The case's `minDelta`; null for none. */
  minDelta: number | null;
  /** How many valid runs stand behind each side. */
  n: { a: number; b: number };
  /** The mean run score of each side; null for a side with no valid run. */
  a: number | null;
  b: number | null;
  /** Null unless a subject is "none", and for a guard case. */
  discrimination: Discrimination | null;
}

/** The comparison of one harness. */
export interface HarnessDelta {
  harness: string;
  cases: CaseDelta[];
  /** The delta of the suite score over the cases scored on both sides; `cases` is how many that is. */
  suite: Judged & {
    cases: number;
    /** The fewest valid runs on a side in any case the suite delta covers; null for no case. */
    fewest: number | null;
  };
}

/** A comparison of two subjects: the delta, interval and verdict of each case and of the suite. */
export interface Comparison {
  harnesses: HarnessDelta[];
}

/** What a comparison is made from. */
export interface CompareInput {
  /** The harness ids, in report order. */
  harnesses: string[];
  /** For each harness id, the cases it ran. */
  applied: Record<string, Case[]>;
  /** Every run. */
  records: RunRecord[];
  /** The subject kinds by label: "none" turns the discrimination on. */
  kinds: { a: string; b: string };
  /** The seed of the bootstrap. */
  seed: number;
  /** The noise file; null for none. */
  noise: NoiseFile | null;
}

/**
 * Takes the valid run scores of one case, harness and side.
 * @param records - Every run.
 * @param key - The harness, case and subject label.
 * @param key.harness - The harness id.
 * @param key.id - The case id.
 * @param key.label - The subject label.
 * @returns The scores of the runs that have one, in plan order.
 */
const scoresOf = (
  records: RunRecord[],
  key: { harness: string; id: string; label: string },
): number[] =>
  records.flatMap((record) =>
    record.harness === key.harness &&
    record.caseId === key.id &&
    record.subject === key.label &&
    record.score !== null
      ? [record.score]
      : [],
  );

/**
 * Judges an interval, or says there is none.
 * @param found - The bootstrap's result; null for no runs on a side.
 * @param noise - The noise bound; null for none.
 * @param enough - Whether enough runs stand behind each side to judge; when not, the verdict is "too few runs".
 * @returns The delta, interval, verdict and the noise used.
 */
function judged(
  found: Interval | null,
  noise: number | null,
  enough: boolean,
): Judged {
  if (found === null) {
    return { delta: null, low: null, high: null, verdict: null, noise };
  }
  return {
    ...found,
    verdict: enough ? verdict(found.delta, found, noise) : "too few runs",
    noise,
  };
}

/**
 * Labels a case by what the none arm and the subject arm show.
 * @param sides - What the case showed.
 * @param sides.none - The mean score of the none arm.
 * @param sides.subject - The mean score of the subject arm.
 * @param sides.helped - Whether the delta, taken from the none arm to the subject, has the verdict "helped".
 * @returns The first label that fits: non-discriminating, failing with the subject, discriminating, no evidence.
 */
function label(sides: {
  none: number | null;
  subject: number | null;
  helped: boolean;
}): Discrimination {
  const { none, subject, helped } = sides;
  if (none !== null && none >= NON_DISCRIMINATING_FLOOR) {
    return "non-discriminating";
  }
  if (subject !== null && subject < FAILING_CEILING) {
    return "failing with the subject";
  }
  return helped ? "discriminating" : "no evidence";
}

/**
 * Finds which arm is "none", when exactly one is.
 * @param kinds - The kind of each subject.
 * @param kinds.a - The kind of subject A.
 * @param kinds.b - The kind of subject B.
 * @returns "a" or "b"; null when neither or both are none.
 */
function noneArm(kinds: { a: string; b: string }): "a" | "b" | null {
  if (kinds.a === "none" && kinds.b !== "none") return "a";
  return kinds.b === "none" && kinds.a !== "none" ? "b" : null;
}

/**
 * Labels one case by what the none arm and the subject arm show.
 * @param none - Which label is none: "a" or "b".
 * @param shown - What the case showed.
 * @param shown.means - The mean score of A and of B; null for a side with no valid run.
 * @param shown.found - The bootstrap of B minus A; null for no delta.
 * @param shown.bound - The noise bound of the case; null for none.
 * @param shown.enough - Whether enough runs stand behind each side to call the subject helped.
 * @returns The label.
 */
function discriminate(
  none: "a" | "b",
  shown: {
    means: (number | null)[];
    found: Interval | null;
    bound: number | null;
    enough: boolean;
  },
): Discrimination {
  const { means, found, bound, enough } = shown;
  const [meanA = null, meanB = null] = means;
  // The delta from the none arm to the subject: B minus A when A is none, else A minus B.
  const towards =
    found === null || none === "a"
      ? found
      : { delta: -found.delta, low: -found.high, high: -found.low };
  return label({
    none: none === "a" ? meanA : meanB,
    subject: none === "a" ? meanB : meanA,
    helped:
      enough &&
      towards !== null &&
      verdict(towards.delta, towards, bound) === "helped",
  });
}

/**
 * Compares the two subjects on every case of one harness, and on its suite.
 * @param input - What the comparison is made from.
 * @param harness - The harness id.
 * @returns The harness's comparison. A case is judged against its own `maxAbsDelta` in the noise file, the suite
 *   against `p95AbsDelta`. The suite delta is stratified: the runs are resampled within each case that has a valid run
 *   on both sides.
 */
function harnessDelta(input: CompareInput, harness: string): HarnessDelta {
  const { records, seed, kinds } = input;
  // A noise file measures one harness, and says nothing about another.
  const noise = input.noise?.harness === harness ? input.noise : null;
  const options = (name: string) => ({
    resamples: RESAMPLES,
    seed: seedFor(seed, `${harness}\u0000${name}`),
  });
  const none = noneArm(kinds);
  const strata: Stratum[] = [];
  const cases = (input.applied[harness] ?? []).map((caseDef): CaseDelta => {
    const { id } = caseDef;
    const a = scoresOf(records, { harness, id, label: "a" });
    const b = scoresOf(records, { harness, id, label: "b" });
    const bound = noise?.perCase[id]?.p95AbsDelta ?? null;
    const enough = Math.min(a.length, b.length) >= MIN_RUNS_FOR_VERDICT;
    const found = bootstrapDelta(a, b, options(id));
    if (found !== null) strata.push({ a, b, weight: caseDef.weight });
    const mine = judged(found, bound, enough);
    const [meanA, meanB] = [a, b].map((runs) =>
      runs.length === 0 ? null : mean(runs),
    );
    return {
      id,
      guard: caseDef.guard,
      minDelta: caseDef.minDelta ?? null,
      n: { a: a.length, b: b.length },
      a: meanA ?? null,
      b: meanB ?? null,
      ...mine,
      discrimination:
        none === null || caseDef.guard
          ? null
          : discriminate(none, {
              means: [meanA ?? null, meanB ?? null],
              found,
              bound,
              enough,
            }),
    };
  });
  const suiteBound = noise?.suite.p95AbsDelta ?? null;
  const suite = bootstrapSuite(strata, options("suite"));
  const fewest =
    strata.length === 0
      ? null
      : Math.min(...strata.flatMap(({ a, b }) => [a.length, b.length]));
  return {
    harness,
    cases,
    suite: {
      ...judged(suite, suiteBound, (fewest ?? 0) >= MIN_RUNS_FOR_SUITE),
      cases: strata.length,
      fewest,
    },
  };
}

/**
 * Compares subject A with subject B, for every harness.
 * @param input - What the comparison is made from.
 * @returns One entry for each harness. The same runs, seed and noise file always give the same entries.
 */
export const compare = (input: CompareInput): Comparison => ({
  harnesses: input.harnesses.map((harness) => harnessDelta(input, harness)),
});

/**
 * Lists the delta bars that the subject under test did not reach: `--min-delta` for each suite, and the `minDelta` of
 * each case. A bar is on the point delta, B minus A, not on the interval.
 * @param comparison - The comparison; null for one subject, which has no delta.
 * @param minDelta - `--min-delta`; null for none.
 * @returns One line for each missed bar. A delta that does not exist, because a side has no valid run, does not reach
 *   a bar.
 */
export function failedDeltaBars(
  comparison: Comparison | null,
  minDelta: number | null,
): string[] {
  if (comparison === null) return [];
  const bar = minDelta ?? undefined;
  return comparison.harnesses.flatMap(({ harness, cases, suite }) =>
    // A harness to which no case applies has no delta to measure against a bar.
    cases.length === 0
      ? []
      : [
          ...(bar !== undefined && missesBar(suite.delta, bar)
            ? [
                `${harness}: suite delta ${formatDelta(suite.delta)} does not reach --min-delta ${formatDelta(bar)}`,
              ]
            : []),
          ...cases.flatMap((one) =>
            one.minDelta !== null && missesBar(one.delta, one.minDelta)
              ? [
                  `${harness}: case \`${one.id}\` delta ${formatDelta(one.delta)} does not reach its minDelta ${formatDelta(one.minDelta)}`,
                ]
              : [],
          ),
        ],
  );
}
