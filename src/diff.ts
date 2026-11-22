import { matchChecks } from "./check-match.js";
import type { Check } from "./checks/index.js";
import { describeCheck } from "./checks/index.js";
import type { Results } from "./evaluate.js";
import type { RunMeta } from "./meta.js";
import type { RunRecord } from "./run.js";
import { invalidReason } from "./run.js";

/** A check passes for a case when its mean score over the valid runs is at least this. */
const PASSING = 0.5;

/** What one side of a diff says of a case. */
export interface SideCase {
  score: number | null;
  runs: { valid: number; planned: number };
  /** The cost of the case's runs, judge and decision included; null when none reported one. */
  costUsd: number | null;
  durationMs: number;
}

/** A check whose pass or fail changed. */
export interface CheckChange {
  description: string;
  /** The mean score over the valid runs on each side. */
  from: number;
  to: number;
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

/** What changed between two results. */
export interface Diff {
  /** Why the two are not a fair pair; empty when nothing differs. */
  warnings: string[];
  /** The label of the subject under test on each side: the last subject. */
  labels: { a: string; b: string };
  cases: CaseDiff[];
  /** Each harness's suite score on both sides. */
  suites: { harness: string; a: number | null; b: number | null }[];
  totals: { a: Totals; b: Totals };
}

/** The cost and time of every run on one side. */
export interface Totals {
  runs: number;
  costUsd: number | null;
  durationMs: number;
}

const labelOf = (results: Results): string =>
  results.subjects.at(-1)?.label ?? "subject";

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
 * @param harness - The id of the harness whose runs are read.
 * @param caseId - The id of the case whose runs are read.
 * @returns The case's score and counts, its cost and time; null when the side has no such case.
 */
function sideCase(
  results: Results,
  harness: string,
  caseId: string,
): SideCase | null {
  const scored = results.suites
    .find((suite) => suite.harness === harness)
    ?.cases.find((one) => one.id === caseId);
  if (scored === undefined) return null;
  const label = labelOf(results);
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
 * Takes the mean score of each check over the valid runs of a case.
 * @param results - One side.
 * @param harness - The id of the harness whose runs are read.
 * @param caseId - The id of the case whose runs are read.
 * @returns The checks, and for each its mean score; null when the case has no valid run.
 */
function checkMeans(
  results: Results,
  harness: string,
  caseId: string,
): { checks: Check[]; means: number[] } | null {
  const label = labelOf(results);
  const valid = results.records.filter(
    (one) =>
      one.harness === harness &&
      one.caseId === caseId &&
      one.subject === label &&
      invalidReason(one) === null,
  );
  const [first] = valid;
  if (first === undefined) return null;
  return {
    checks: first.checks,
    means: first.checks.map(
      (_check, index) =>
        valid.reduce((sum, one) => sum + (one.checks[index]?.score ?? 0), 0) /
        valid.length,
    ),
  };
}

/**
 * Finds the checks of a case that started or stopped passing.
 * @param a - The earlier results.
 * @param b - The later results.
 * @param where - The harness id and the case id.
 * @param where.harness - The id of the harness whose runs are read.
 * @param where.caseId - The id of the case whose runs are read.
 * @returns The checks that pass on one side and not on the other, matched by description, then by position among
 *   those that share one.
 */
function checkChanges(
  a: Results,
  b: Results,
  where: { harness: string; caseId: string },
): Pick<CaseDiff, "newlyFailing" | "newlyPassing"> {
  const before = checkMeans(a, where.harness, where.caseId);
  const after = checkMeans(b, where.harness, where.caseId);
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
 * Compares two sets of results: the score of each case with its run counts, the checks that started or stopped
 * passing, and the cost and time. The subject under test of each side is its last subject.
 * @param a - The earlier results.
 * @param b - The later results.
 * @returns The differences, and the warnings that say the two may not be a fair pair: a different model, harness set,
 *   tool version or case hash, or no `meta` on a side.
 */
export function diffResults(a: Results, b: Results): Diff {
  const labelA = labelOf(a);
  const labelB = labelOf(b);
  const harnesses = [...new Set([...a.harnesses, ...b.harnesses])];
  return {
    warnings: warningsOf(a, b),
    labels: { a: labelA, b: labelB },
    cases: pairsOf(a, b).map((pair) => ({
      ...pair,
      a: sideCase(a, pair.harness, pair.caseId),
      b: sideCase(b, pair.harness, pair.caseId),
      ...checkChanges(a, b, pair),
    })),
    suites: harnesses.map((harness) => ({
      harness,
      a: a.suites.find((one) => one.harness === harness)?.suite[labelA] ?? null,
      b: b.suites.find((one) => one.harness === harness)?.suite[labelB] ?? null,
    })),
    totals: {
      a: totalsOf(a.records.filter((one) => one.subject === labelA)),
      b: totalsOf(b.records.filter((one) => one.subject === labelB)),
    },
  };
}

/**
 * Says what differs between the settings of two results.
 * @param a - The earlier results.
 * @param b - The later results.
 * @returns One line for each difference; a line for each side that has no meta, which says nothing else about it.
 */
function warningsOf(a: Results, b: Results): string[] {
  const warnings: string[] = [];
  // Results written before `meta` existed lack it.
  const metaA = a.meta as RunMeta | undefined;
  const metaB = b.meta as RunMeta | undefined;
  if (metaA === undefined || metaB === undefined) {
    for (const [name, meta] of [
      ["A", metaA],
      ["B", metaB],
    ] as const) {
      if (meta === undefined) {
        warnings.push(
          `${name} has no meta, so its models, versions and case hashes cannot be compared`,
        );
      }
    }
  }
  if (a.harnesses.join(",") !== b.harnesses.join(",")) {
    warnings.push(
      `the harnesses differ: A ${a.harnesses.join(", ")}; B ${b.harnesses.join(", ")}`,
    );
  }
  if (metaA === undefined || metaB === undefined) return warnings;
  for (const kind of ["agent", "judge", "decision"] as const) {
    if (metaA.models[kind] !== metaB.models[kind]) {
      warnings.push(
        `the ${kind} model differs: A ${metaA.models[kind] ?? "unset"}; B ${metaB.models[kind] ?? "unset"}`,
      );
    }
  }
  if (metaA.toolVersion !== metaB.toolVersion) {
    warnings.push(
      `the tool version differs: A ${metaA.toolVersion}; B ${metaB.toolVersion}`,
    );
  }
  const changed = changedHashes(metaA.caseHashes, metaB.caseHashes);
  if (changed.length > 0) {
    warnings.push(
      `the case changed (its hash differs) in: ${changed.join(", ")}`,
    );
  }
  return warnings;
}

/**
 * Finds the cases whose hash differs between two sides.
 * @param a - The earlier side's hashes, by harness id and case id.
 * @param b - The later side's.
 * @returns `<harness> <case>` for each pair whose hash differs or is on one side only.
 */
function changedHashes(
  a: Record<string, Record<string, string>>,
  b: Record<string, Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(
    (harness) => {
      const ids = new Set([
        ...Object.keys(a[harness] ?? {}),
        ...Object.keys(b[harness] ?? {}),
      ]);
      return [...ids]
        .filter((id) => a[harness]?.[id] !== b[harness]?.[id])
        .map((id) => `${harness} ${id}`);
    },
  );
}
