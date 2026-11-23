import type { Check } from "../checks/index.js";
import { isDecision, isJudged } from "../checks/index.js";
import type { RunRecord, Usage } from "../run.js";
import { formatScore } from "../score.js";
import { median } from "../stats.js";

const MS_PER_SECOND = 1000;
const COST_DECIMALS = 4;

/** A number of a run that the report shows beside the scores. */
export interface Metric {
  title: string;
  value: (usage: Usage) => number | null;
  format: (value: number) => string;
}

export const METRICS: Metric[] = [
  {
    title: "Duration",
    value: (usage) => usage.durationMs / MS_PER_SECOND,
    format: (v) => `${v.toFixed(1)} s`,
  },
  {
    title: "Input tokens",
    value: (usage) => usage.tokens?.input ?? null,
    format: (v) => String(Math.round(v)),
  },
  {
    title: "Output tokens",
    value: (usage) => usage.tokens?.output ?? null,
    format: (v) => String(Math.round(v)),
  },
  {
    title: "Cost",
    value: (usage) => usage.costUsd,
    format: (v) => `$${v.toFixed(COST_DECIMALS)}`,
  },
];

/**
 * Finds the middle of the values of a metric.
 * @param values - The numbers, in any order.
 * @returns Their median; null for no values.
 */
export const medianOf = (values: number[]): number | null =>
  values.length === 0 ? null : median(values);

/**
 * Shows one value for each subject, and the change from the first to the second when there are two.
 * @param values - One value for each subject; null is a missing one.
 * @param format - Renders a value, and the size of the change.
 * @param withChange - Whether to add the change from the first to the second value. Default: true. A table of more than two
 *   subjects leaves it out, because one change would say nothing of the others.
 * @returns The cell text, "n/a" when every value is missing.
 */
export function versus(
  values: (number | null)[],
  format: (value: number) => string,
  withChange = true,
): string {
  if (values.every((value) => value === null)) return "n/a";
  const shown = values
    .map((value) => (value === null ? "n/a" : format(value)))
    .join(" / ");
  const [first, second] = values;
  if (!withChange || first == null || second == null) return shown;
  const delta = second - first;
  return `${shown} (${delta < 0 ? "-" : "+"}${format(Math.abs(delta))})`;
}

/**
 * Sums up how one check went over the valid runs of one subject.
 * @param check - Decides the form: a rule gives pass or fail, a judge or a decision model gives a score.
 * @param index - Its place among the case's checks.
 * @param runs - What stands behind the rate.
 * @param runs.valid - The valid runs of the case and subject.
 * @param runs.planned - How many runs the plan holds for them.
 * @returns For a deterministic check the share of runs that passed it, for a judged check or a decision check its
 *   mean score with the number of runs behind it.
 */
export function checkRate(
  check: Check,
  index: number,
  runs: { valid: RunRecord[]; planned: number },
): string {
  const { valid, planned } = runs;
  if (valid.length === 0) return "n/a";
  // A check of a reply turn that was not asked has no score and is left out of the rate.
  const records = valid.filter(
    (record) => record.checks[index]?.notScored === undefined,
  );
  const unasked = `not scored: turn ${String(check.turn)} was not asked`;
  if (records.length === 0) return unasked;
  const total = records.reduce(
    (sum, record) => sum + (record.checks[index]?.score ?? 0),
    0,
  );
  const rate =
    isJudged(check) || isDecision(check)
      ? `${formatScore(total / records.length)} (${String(records.length)} of ${String(planned)} runs)`
      : `${String(total)}/${String(records.length)}`;
  return records.length < valid.length
    ? `${rate} (${unasked} in ${String(valid.length - records.length)} of ${String(valid.length)} runs)`
    : rate;
}

/**
 * Reports what a scoring model cost, which the table leaves out.
 * @param title - Names the model's role: the judge, or the decision model.
 * @param judged - What the model cost each run that it scored.
 * @returns The lines to add under the table; none when it scored no run. A metric that any of the runs lacks is left out.
 */
export function scorerLine(
  title: string,
  judged: NonNullable<RunRecord["judge"]>[],
): string[] {
  if (judged.length === 0) return [];
  const calls = judged.reduce((total, usage) => total + usage.calls, 0);
  const totals = METRICS.flatMap((metric) => {
    const values = judged.flatMap((usage) => metric.value(usage) ?? []);
    if (values.length < judged.length) return [];
    const total = values.reduce((sum, value) => sum + value, 0);
    return [`${metric.title.toLowerCase()} ${metric.format(total)}`];
  });
  const hits = judged.reduce(
    (total, usage) => total + (usage.cacheHits ?? 0),
    0,
  );
  const cached = hits > 0 ? [`${String(hits)} cache hits`] : [];
  const parts = [`${String(calls)} calls`, ...cached, ...totals];
  return [
    "",
    `${title}, in total and not counted in the table: ${parts.join(", ")}`,
  ];
}
