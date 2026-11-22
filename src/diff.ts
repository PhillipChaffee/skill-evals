import type { CheckChange } from "./diff-checks.js";
import { checkChanges } from "./diff-checks.js";
import { labelPairs, warningsOf } from "./diff-warnings.js";
import type { Results } from "./evaluate.js";
import type { RunRecord } from "./run.js";

/** What one side of a diff says of a case. */
export interface SideCase {
  score: number | null;
  runs: { valid: number; planned: number };
  /** The cost of the case's runs, judge and decision included; null when none reported one. */
  costUsd: number | null;
  durationMs: number;
}

/** What changed for one case of one harness. */
export interface CaseDiff {
  harness: string;
  caseId: string;
  /** Null when the side has no such case. */
  a: SideCase | null;
  b: SideCase | null;
  newlyFailing: CheckChange[];
  newlyPassing: CheckChange[];
}

/** What changed for one subject label that both results have. */
export interface Section {
  /** The subject label on each side. */
  labels: { a: string; b: string };
  cases: CaseDiff[];
  /** Each harness's suite score on both sides. */
  suites: { harness: string; a: number | null; b: number | null }[];
  totals: { a: Totals; b: Totals };
}

/** What changed between two results. */
export interface Diff {
  /** Why the two are not a fair pair; empty when nothing differs. */
  warnings: string[];
  /** One section for each subject label that both results have. */
  sections: Section[];
}

/** The cost and time of every run on one side. */
export interface Totals {
  runs: number;
  costUsd: number | null;
  durationMs: number;
}

/**
 * Adds up what runs cost.
 * @param records - Run records.
 * @returns The cost of each run with its judge and decision calls; null when no run reported one.
 */
function costOf(records: RunRecord[]): number | null {
  const costs = records.flatMap((record) =>
    [record.costUsd, record.judge?.costUsd, record.decision?.costUsd].filter(
      (cost) => cost !== null && cost !== undefined,
    ),
  );
  return costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0);
}

/**
 * Sums up a list of runs.
 * @param records - Run records.
 * @returns How many, what they cost, and how long they took.
 */
function totalsOf(records: RunRecord[]): Totals {
  return {
    runs: records.length,
    costUsd: costOf(records),
    durationMs: records.reduce((sum, record) => sum + record.durationMs, 0),
  };
}

/**
 * Reads one side's runs of a case.
 * @param results - One side.
 * @param where - Which runs to read.
 * @param where.harness - The id of the harness whose runs are read.
 * @param where.caseId - The id of the case whose runs are read.
 * @param where.label - The subject whose runs are read.
 * @returns The case's score and counts, its cost and time; null when the side has no such case.
 */
function sideCase(
  results: Results,
  where: { harness: string; caseId: string; label: string },
): SideCase | null {
  const { harness, caseId, label } = where;
  const scored = results.suites
    .find((suite) => suite.harness === harness)
    ?.cases.find((one) => one.id === caseId);
  if (scored === undefined) return null;
  const records = results.records.filter(
    (one) =>
      one.harness === harness && one.caseId === caseId && one.subject === label,
  );
  const totals = totalsOf(records);
  return {
    score: scored.scores[label] ?? null,
    runs: scored.runs[label] ?? { valid: 0, planned: 0 },
    costUsd: totals.costUsd,
    durationMs: totals.durationMs,
  };
}

/**
 * Lists the (harness, case) pairs of both sides, the earlier side's first.
 * @param a - The earlier results.
 * @param b - The later results.
 * @returns Each pair once.
 */
function pairsOf(
  a: Results,
  b: Results,
): { harness: string; caseId: string }[] {
  const seen = new Set<string>();
  return [a, b].flatMap((results) =>
    results.suites.flatMap((suite) =>
      suite.cases.flatMap((one) => {
        const key = `${suite.harness}\n${one.id}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ harness: suite.harness, caseId: one.id }];
      }),
    ),
  );
}

/**
 * Compares the runs of one subject label on both sides.
 * @param sides - The earlier and the later results.
 * @param sides.a - The earlier results.
 * @param sides.b - The later results.
 * @param labels - The subject label on each side.
 * @param labels.a - The label on the earlier side.
 * @param labels.b - The label on the later side.
 * @returns The section for that label.
 */
function sectionOf(
  sides: { a: Results; b: Results },
  labels: { a: string; b: string },
): Section {
  const { a, b } = sides;
  const harnesses = [...new Set([...a.harnesses, ...b.harnesses])];
  return {
    labels,
    cases: pairsOf(a, b).map((pair) => ({
      ...pair,
      a: sideCase(a, { ...pair, label: labels.a }),
      b: sideCase(b, { ...pair, label: labels.b }),
      ...checkChanges(sides, { ...pair, labels }),
    })),
    suites: harnesses.map((harness) => ({
      harness,
      a:
        a.suites.find((one) => one.harness === harness)?.suite[labels.a] ??
        null,
      b:
        b.suites.find((one) => one.harness === harness)?.suite[labels.b] ??
        null,
    })),
    totals: {
      a: totalsOf(a.records.filter((one) => one.subject === labels.a)),
      b: totalsOf(b.records.filter((one) => one.subject === labels.b)),
    },
  };
}

/**
 * Compares two sets of results: the score of each case with its run counts, the checks that started or stopped
 * passing, and the cost and time, for every subject label that both have.
 * @param a - The earlier results.
 * @param b - The later results.
 * @returns The differences, and the warnings that say the two may not be a fair pair: a different model, harness set,
 *   tool version or case hash, no `meta` on a side, or a subject label that only one has.
 */
export function diffResults(a: Results, b: Results): Diff {
  const { pairs, warnings } = labelPairs(a, b);
  return {
    warnings: [...warningsOf(a, b), ...warnings],
    sections: pairs.map((labels) => sectionOf({ a, b }, labels)),
  };
}
