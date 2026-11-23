import { median } from "../stats.js";
import type { RunRecord } from "../run.js";
import { costOf } from "../run-cost.js";

/** A run of the plan, by the pair that the estimate is made for. */
interface Pair {
  harness: string;
  caseId: string;
}

/** What the earlier runs say a plan will take. */
export interface Estimate {
  /** The planned runs that an earlier run of the same harness and case covers, for the duration. */
  covered: number;
  /** The planned runs that an earlier run of the same harness and case with a reported cost covers, for the cost. */
  costed: number;
  total: number;
  /** The sum of each covered run's median cost; null when no earlier run reported a cost. */
  costUsd: number | null;
  /** The sum of each covered run's median duration, divided by the jobs. */
  durationMs: number;
}

/**
 * Estimates what a plan costs and how long it takes from the runs of an earlier command.
 * @param earlier - The records of the earlier command.
 * @param planned - The pair of harness and case of each run of the plan.
 * @param jobs - How many runs are in flight at once.
 * @returns The estimate, from the median of each pair of harness and case.
 */
export function estimateOf(
  earlier: RunRecord[],
  planned: Pair[],
  jobs: number,
): Estimate {
  const byPair = new Map<string, RunRecord[]>();
  for (const record of earlier) {
    const name = `${record.harness}\n${record.caseId}`;
    byPair.set(name, [...(byPair.get(name) ?? []), record]);
  }
  const medians = planned.flatMap(({ harness, caseId }) => {
    const records = byPair.get(`${harness}\n${caseId}`);
    if (records === undefined) return [];
    const costs = records.flatMap((record) => costOf([record]) ?? []);
    return [
      {
        durationMs: median(records.map((record) => record.durationMs)),
        costUsd: costs.length === 0 ? null : median(costs),
      },
    ];
  });
  const costs = medians.flatMap(({ costUsd }) => costUsd ?? []);
  return {
    covered: medians.length,
    costed: costs.length,
    total: planned.length,
    costUsd: costs.length === 0 ? null : costs.reduce((x, y) => x + y, 0),
    durationMs:
      medians.reduce((sum, { durationMs }) => sum + durationMs, 0) / jobs,
  };
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECOND_DIGITS = 2;
const CENT_DIGITS = 2;

/**
 * Writes the estimate as text.
 * @param estimate - What `estimateOf` returned, for the runs that are left.
 * @param from - Where the runs came from and how the plan is run.
 * @param from.dir - The output directory of the earlier command, named in the first line.
 * @param from.jobs - The `--jobs` of the plan, named beside the duration.
 * @param from.reused - How many planned runs a resume would reuse, and how many runs the plan has in all; null when
 *   the earlier command left no `results.jsonl`, so that no key can be compared.
 * @returns The lines to print.
 */
export function renderEstimate(
  estimate: Estimate,
  from: {
    dir: string;
    jobs: number;
    reused: { count: number; of: number } | null;
  },
): string[] {
  const seconds = Math.round(estimate.durationMs / MS_PER_SECOND);
  const clock = `${String(Math.floor(seconds / SECONDS_PER_MINUTE))}:${String(seconds % SECONDS_PER_MINUTE).padStart(SECOND_DIGITS, "0")}`;
  const cost =
    estimate.costUsd === null
      ? "unknown, no earlier run reported a cost"
      : `$${estimate.costUsd.toFixed(CENT_DIGITS)} (from ${String(estimate.costed)} of ${String(estimate.total)} runs)`;
  const left = String(estimate.total);
  return [
    from.reused === null
      ? `Estimate from the valid runs in ${from.dir}, by the median of each harness and case, for the ${left} runs:`
      : `${String(from.reused.count)} of ${String(from.reused.of)} runs would be reused; estimate from the valid runs in ${from.dir}, by the median of each harness and case, for the remaining ${left}:`,
    `- cost: ${cost}`,
    `- duration: ${clock} (mm:ss) at --jobs ${String(from.jobs)}`,
    `- estimate covers ${String(estimate.covered)} of ${left} runs`,
  ];
}
