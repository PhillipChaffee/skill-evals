const MS_PER_SECOND = 1000;
const HALF = 2;
const DIGITS = 2;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SHORT_DECIMALS = 4;
const LONG_DECIMALS = 2;

/** How far a command has got. */
export interface Progress {
  /** Runs that are finished, those reused from an earlier command included. */
  done: number;
  /** Every run of the plan. */
  total: number;
  /** What this command has spent, reused runs excluded; null while no run has reported a cost. */
  spentUsd: number | null;
  /** How many costs of this command were not reported; the spend is then a lower bound. */
  unreported: number;
  /** The time left in milliseconds; null until a run of this command has finished. */
  etaMs: number | null;
}

/**
 * Finds the middle of some durations.
 * @param values - At least one number.
 * @returns The median; the mean of the two middle ones for an even count.
 */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / HALF);
  return sorted.length % HALF === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / HALF;
}

/**
 * Estimates the time left.
 * @param remaining - Runs not finished yet.
 * @param durations - The wall time of each run that this command finished, in milliseconds; reused runs are not here.
 * @param jobs - How many runs are in flight at once.
 * @returns The remaining runs times the median duration, divided by the jobs; null when no run has finished.
 */
export const etaOf = (
  remaining: number,
  durations: number[],
  jobs: number,
): number | null =>
  durations.length === 0 ? null : (remaining * median(durations)) / jobs;

/**
 * Writes a time as `mm:ss`, or `h:mm:ss` from one hour on.
 * @param ms - Milliseconds.
 * @returns The time, rounded to the second.
 */
export function clockText(ms: number): string {
  const seconds = Math.round(ms / MS_PER_SECOND);
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const two = (value: number): string => String(value).padStart(DIGITS, "0");
  const rest = two(seconds % SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return `${two(minutes)}:${rest}`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return `${String(hours)}:${two(minutes % MINUTES_PER_HOUR)}:${rest}`;
}

/**
 * Writes the progress of a command as the progress line ends.
 * @param progress - How far the command has got.
 * @returns `[n/N] $<spent> ETA <mm:ss>`. The spend has four decimals under one dollar and two from there on, is `≥$x`
 *   when some cost was not reported, and is `$?` while none has been. The time is `--:--` until a run of this command has finished.
 */
export function progressText(progress: Progress): string {
  const { done, total, spentUsd, etaMs, unreported } = progress;
  const spent =
    spentUsd === null
      ? "$?"
      : `${unreported > 0 ? "\u2265$" : "$"}${spentUsd.toFixed(spentUsd < 1 ? SHORT_DECIMALS : LONG_DECIMALS)}`;
  const eta = etaMs === null ? "--:--" : clockText(etaMs);
  return `[${String(done)}/${String(total)}] ${spent} ETA ${eta}`;
}
