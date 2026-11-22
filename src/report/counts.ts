import type { RunCount } from "../score.js";

const PAIR = 2;

/**
 * Tells whether a report compares exactly two subjects, which it shows as A / B with one change between them.
 * @param labels - The subject labels.
 * @returns True for two labels; a table of more has one value for each and no single change.
 */
export const isPair = (labels: string[]): boolean => labels.length === PAIR;

/**
 * Words how many runs stand behind a score, to print beside it.
 * @param runs - The counts by subject label.
 * @param labels - The subject labels in report order: one, or two for a comparison.
 * @returns "(3 of 3 runs)" for one subject, and "(A 3 of 3 runs, B 2 of 3 runs)" for two. The first number is the valid
 *   runs, the second the runs the plan holds. A subject with no count reads "0 of 0 runs".
 */
export function runsText(
  runs: Record<string, RunCount>,
  labels: string[],
): string {
  const one = (label: string): string => {
    const { valid, planned } = runs[label] ?? { valid: 0, planned: 0 };
    return `${String(valid)} of ${String(planned)} runs`;
  };
  return labels.length > 1
    ? `(${labels.map((label) => `${label.toUpperCase()} ${one(label)}`).join(", ")})`
    : `(${one(labels[0] ?? "")})`;
}
