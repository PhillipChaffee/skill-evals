import type { RunRecord } from "./run-plan.js";

/**
 * Adds up what runs cost. `summary.json`, `diff` and `plan` all count cost with this one function.
 * @param records - Run records.
 * @returns The sum of every reported cost: each run's agent, judge and decision calls, and its failed attempts; null
 *   when none was reported.
 */
export function costOf(records: RunRecord[]): number | null {
  const costs = records.flatMap((record) => [
    record.costUsd,
    record.judge?.costUsd ?? null,
    record.decision?.costUsd ?? null,
    ...(record.attempts ?? []).map((attempt) => attempt.costUsd),
  ]);
  const reported = costs.filter((cost) => cost !== null);
  return reported.length === 0
    ? null
    : reported.reduce((sum, cost) => sum + cost, 0);
}
