import { matchChecks } from "./check-match.js";
import type { Check } from "./checks/index.js";
import { describeCheck } from "./checks/index.js";
import type { Results } from "./evaluate.js";
import { invalidReason } from "./run.js";

/** A check passes for a case when its mean score over the valid runs is at least this. */
const PASSING = 0.5;

/** A check whose pass or fail changed. */
export interface CheckChange {
  description: string;
  /** The mean score over the valid runs on each side. */
  from: number;
  to: number;
}

/** The checks that started or stopped passing. */
export interface CheckChanges {
  newlyFailing: CheckChange[];
  newlyPassing: CheckChange[];
}

/** One side of a case: which subject, in which harness, and which case. */
interface Where {
  harness: string;
  caseId: string;
  label: string;
}

/**
 * Takes the mean score of each check over the valid runs of a case. A check is followed by its identity, not by its
 * index, so a run whose checks are in another order still counts toward the right one.
 * @param results - One side.
 * @param where - Which runs to read.
 * @returns The checks of the first valid run and for each its mean score; null when the case has no valid run.
 */
function checkMeans(
  results: Results,
  where: Where,
): { checks: Check[]; means: number[] } | null {
  const valid = results.records.filter(
    (one) =>
      one.harness === where.harness &&
      one.caseId === where.caseId &&
      one.subject === where.label &&
      invalidReason(one) === null,
  );
  const [first] = valid;
  if (first === undefined) return null;
  const sums = first.checks.map(() => 0);
  const counts = first.checks.map(() => 0);
  for (const one of valid) {
    const matched = matchChecks(first.checks, one.checks);
    for (const [index, check] of one.checks.entries()) {
      const at = matched[index];
      if (at === null || at === undefined) continue;
      sums[at] = (sums[at] ?? 0) + (check.score ?? 0);
      counts[at] = (counts[at] ?? 0) + 1;
    }
  }
  return {
    checks: first.checks,
    means: sums.map((sum, index) => sum / (counts[index] || 1)),
  };
}

/**
 * Finds the checks of a case that started or stopped passing.
 * @param sides - The earlier and the later results.
 * @param sides.a - The earlier results.
 * @param sides.b - The later results.
 * @param where - Which case, and which subject on each side.
 * @param where.harness - The id of the harness whose runs are compared.
 * @param where.caseId - The id of the case whose runs are compared.
 * @param where.labels - The subject label on each side.
 * @param where.labels.a - The label on the earlier side.
 * @param where.labels.b - The label on the later side.
 * @returns The checks that pass on one side and not on the other, matched by description, then by position among
 *   those that share one.
 */
export function checkChanges(
  sides: { a: Results; b: Results },
  where: {
    harness: string;
    caseId: string;
    labels: { a: string; b: string };
  },
): CheckChanges {
  const { harness, caseId, labels } = where;
  const before = checkMeans(sides.a, { harness, caseId, label: labels.a });
  const after = checkMeans(sides.b, { harness, caseId, label: labels.b });
  const failing: CheckChange[] = [];
  const passing: CheckChange[] = [];
  if (before === null || after === null) {
    return { newlyFailing: failing, newlyPassing: passing };
  }
  const matched = matchChecks(before.checks, after.checks);
  for (const [index, check] of after.checks.entries()) {
    const earlier = matched[index];
    const from =
      earlier === null || earlier === undefined
        ? undefined
        : before.means[earlier];
    const to = after.means[index];
    if (from === undefined || to === undefined) continue;
    const change = { description: describeCheck(check), from, to };
    if (from >= PASSING && to < PASSING) failing.push(change);
    if (from < PASSING && to >= PASSING) passing.push(change);
  }
  return { newlyFailing: failing, newlyPassing: passing };
}
