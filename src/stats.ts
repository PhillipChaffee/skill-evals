// The statistics behind a comparison: a seeded bootstrap over run scores, and the verdict drawn from its interval.

/** How many times the runs are resampled. */
export const RESAMPLES = 2000;
/** The share of the bootstrap that the interval covers. */
export const CONFIDENCE = 0.95;

const BOTH_TAILS = 2;
// The tails left outside a 95% interval, split evenly.
const TAIL = (1 - CONFIDENCE) / BOTH_TAILS;
// Absorbs float error, so that a delta of 0.2 is not above a bound of 0.2.
const EPSILON = 1e-9;
const UINT32 = 4294967296;
const MIN_FOR_SPREAD = 2;
const RANK_SCALE = 1e6;
// The constants of mulberry32 and of the 32-bit FNV-1a hash.
const MULBERRY_STEP = 0x6d2b79f5;
const SHIFT_ONE = 15;
const SHIFT_TWO = 7;
const ODD_BITS = 61;
const SHIFT_THREE = 14;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** A bootstrap's point estimate and its percentile interval. */
export interface Interval {
  /** The difference of the means, B minus A, over the runs as they are. */
  delta: number;
  /** The lower end of the 95% interval. */
  low: number;
  /** The upper end of the 95% interval. */
  high: number;
}

/** What a bootstrap is made with. */
export interface BootstrapOptions {
  /** How many times to resample. Use `RESAMPLES`. */
  resamples: number;
  /** The seed of the generator: the same seed over the same runs gives the same interval. */
  seed: number;
}

/** The runs of one case on each side of a comparison, and how much the case counts for. */
export interface Stratum {
  /** The valid run scores of subject A. */
  a: number[];
  /** The valid run scores of subject B. */
  b: number[];
  /** The case's weight in the suite score. */
  weight: number;
}

/** What the verdict of a delta is: the subject helped, hurt, or the difference is inside the noise. */
export type DeltaVerdict =
  | "helped"
  | "hurt"
  | "within noise"
  /** Set by the comparison, never by `verdict`: too few valid runs behind a side to judge. */
  | "too few runs";

/**
 * Makes a seeded generator, mulberry32.
 * @param seed - Any integer; it is taken modulo 2^32.
 * @returns A function that gives the next number from 0 up to, and not including, 1.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + MULBERRY_STEP) >>> 0;
    let mixed = Math.imul(state ^ (state >>> SHIFT_ONE), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> SHIFT_TWO), mixed | ODD_BITS);
    return ((mixed ^ (mixed >>> SHIFT_THREE)) >>> 0) / UINT32;
  };
}

/**
 * Gives each thing that is bootstrapped its own seed, so that its interval does not depend on the others.
 * @param seed - The seed of the command.
 * @param name - What is bootstrapped: a case, or the suite, with its harness.
 * @returns A seed from the command's and the name's.
 */
export function seedFor(seed: number, name: string): number {
  let hash = FNV_OFFSET;
  for (const char of name) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), FNV_PRIME) >>> 0;
  }
  return (seed ^ hash) >>> 0;
}

/**
 * Averages numbers.
 * @param values - The numbers.
 * @returns Their mean; NaN for none.
 */
export const mean = (values: number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Takes the pooled standard deviation of several groups, each around its own mean.
 * @param groups - The groups of numbers; a group of one has no spread of its own.
 * @returns The square root of the summed squared deviations over the summed degrees of freedom; 0 when no group has
 *   two numbers.
 */
export function pooledSd(groups: number[][]): number {
  let squares = 0;
  let freedom = 0;
  for (const group of groups) {
    if (group.length < MIN_FOR_SPREAD) continue;
    const centre = mean(group);
    squares += group.reduce(
      (sum, value) => sum + (value - centre) * (value - centre),
      0,
    );
    freedom += group.length - 1;
  }
  return freedom === 0 ? 0 : Math.sqrt(squares / freedom);
}

/**
 * Reads a quantile off numbers that are already sorted, by the nearest rank.
 * @param sorted - The numbers, ascending; not empty.
 * @param q - The quantile, from 0 to 1.
 * @returns The number at that rank.
 */
export function quantile(sorted: number[], q: number): number {
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[rank] as number;
}

/**
 * Takes the weighted difference of the means over strata: the mean of the case deltas.
 * @param strata - The cases, each with its runs.
 * @param pick - Gives the runs of a case on one side: as they are, or resampled.
 * @returns B minus A, each side the weighted mean of its case means.
 */
function suiteDelta(
  strata: Stratum[],
  pick: (runs: number[]) => number[],
): number {
  let total = 0;
  let weighted = 0;
  for (const { a, b, weight } of strata) {
    weighted += weight * (mean(pick(b)) - mean(pick(a)));
    total += weight;
  }
  return weighted / total;
}

/**
 * Resamples the runs within each case and takes the suite delta of each resample.
 * @param strata - The cases; each side has at least one run.
 * @param options - The number of resamples and the seed.
 * @returns The resampled deltas, ascending.
 */
export function resampledDeltas(
  strata: Stratum[],
  options: BootstrapOptions,
): number[] {
  const next = mulberry32(options.seed);
  const draw = (runs: number[]): number[] =>
    runs.map(() => runs[Math.floor(next() * runs.length)] as number);
  return Array.from({ length: options.resamples }, () =>
    suiteDelta(strata, draw),
  ).sort((x, y) => x - y);
}

/**
 * Picks the ends of the 95% interval out of sorted resamples, by rank: `low = floor(TAIL * n)` and `high = n - 1 - low`.
 * @param sorted - The resampled deltas, ascending.
 * @returns The lower and upper end. For 2000 resamples the ranks are 50 and 1949.
 */
export function percentileBounds(sorted: number[]): {
  low: number;
  high: number;
} {
  // Rounding first, because TAIL * 2000 is 50.00000000000004 in floating point.
  const rank = Math.floor(
    Math.round(TAIL * sorted.length * RANK_SCALE) / RANK_SCALE,
  );
  return {
    low: sorted[rank] as number,
    high: sorted[sorted.length - 1 - rank] as number,
  };
}

/**
 * Bootstraps the suite delta, stratified: the runs are resampled within each case, never across cases.
 * @param strata - The cases scored on both sides, each with its runs.
 * @param options - The number of resamples and the seed.
 * @returns The suite delta, which is the mean of the case deltas by weight, and its 95% percentile interval; null for
 *   no case.
 */
export function bootstrapSuite(
  strata: Stratum[],
  options: BootstrapOptions,
): Interval | null {
  if (strata.length === 0) return null;
  const deltas = resampledDeltas(strata, options);
  return {
    delta: suiteDelta(strata, (runs) => runs),
    ...percentileBounds(deltas),
  };
}

/**
 * Bootstraps the difference between two sets of run scores, over runs.
 * @param a - The valid run scores of subject A.
 * @param b - The valid run scores of subject B.
 * @param options - The number of resamples and the seed.
 * @returns B minus A and its 95% percentile interval; null when either side has no run.
 */
export function bootstrapDelta(
  a: number[],
  b: number[],
  options: BootstrapOptions,
): Interval | null {
  if (a.length === 0 || b.length === 0) return null;
  return bootstrapSuite([{ a, b, weight: 1 }], options);
}

/**
 * Judges a delta against its interval and the noise of the measurement.
 * @param delta - B minus A.
 * @param interval - The ends of its 95% interval.
 * @param interval.low - The lower end.
 * @param interval.high - The upper end.
 * @param noise - The largest difference that two runs of the same subject showed, from a noise file; null for none.
 * @returns "within noise" when the interval holds 0 or the delta is no larger than the noise; else "helped" for a
 *   positive delta and "hurt" for a negative one.
 */
export function verdict(
  delta: number,
  interval: { low: number; high: number },
  noise: number | null,
): Exclude<DeltaVerdict, "too few runs"> {
  if (interval.low <= EPSILON && interval.high >= -EPSILON) {
    return "within noise";
  }
  if (noise !== null && Math.abs(delta) <= noise + EPSILON) {
    return "within noise";
  }
  return delta > 0 ? "helped" : "hurt";
}
