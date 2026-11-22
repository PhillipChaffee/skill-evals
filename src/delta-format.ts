const DECIMALS = 2;
const MINUS = "−";

/**
 * Renders a score difference with its sign, as every report line shows it.
 * @param delta - B minus A; null for none.
 * @returns "+0.12" or "−0.03" with a true minus sign, two decimals; a value that rounds to zero is "+0.00"; "n/a" for none.
 */
export function formatDelta(delta: number | null): string {
  if (delta === null) return "n/a";
  const text = Math.abs(delta).toFixed(DECIMALS);
  return `${delta < 0 && Number(text) !== 0 ? MINUS : "+"}${text}`;
}

/**
 * Renders a delta and its interval.
 * @param judged - The delta and the ends of its 95% interval.
 * @param judged.delta - B minus A.
 * @param judged.low - The lower end of the interval.
 * @param judged.high - The upper end of the interval.
 * @returns "(+0.12, 95% −0.03..+0.27)".
 */
export const formatInterval = (judged: {
  delta: number;
  low: number;
  high: number;
}): string =>
  `(${formatDelta(judged.delta)}, 95% ${formatDelta(judged.low)}..${formatDelta(judged.high)})`;

/**
 * Words the verdict of a delta for a table cell.
 * @param judged - The verdict, delta and interval; the fields are null when a side has no valid run.
 * @param judged.verdict - "helped", "hurt" or "within noise".
 * @param judged.delta - B minus A.
 * @param judged.low - The lower end of the interval.
 * @param judged.high - The upper end of the interval.
 * @returns "helped (+0.12, 95% −0.03..+0.27)", or "n/a" with no verdict when a side has no valid run.
 */
export function verdictText(judged: {
  verdict: string | null;
  delta: number | null;
  low: number | null;
  high: number | null;
}): string {
  const { verdict, delta, low, high } = judged;
  if (verdict === null || delta === null || low === null || high === null) {
    return "n/a";
  }
  return `${verdict} ${formatInterval({ delta, low, high })}`;
}
