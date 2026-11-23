import type { ExitCode } from "./exit-codes.js";
import { invalidShare } from "./exit-codes.js";
import type { Results } from "./evaluate.js";
import { costOf } from "./run-cost.js";

/** One harness and subject: the score and how many runs stand behind it. */
export interface SummarySuite {
  harness: string;
  /** The subject's label: "subject", "a" or "b". */
  label: string;
  /** The suite score; null when no case has a valid run. */
  score: number | null;
  /** How many cases apply to the harness. */
  applicable: number;
  /** How many cases the suite has. */
  total: number;
  validRuns: number;
  plannedRuns: number;
}

/** What `summary.json` holds: the figures a gate or a dashboard reads, in a stable shape. */
export interface Summary {
  schemaVersion: 1;
  /** The exit code of the command, from the same function as the command line's. */
  exit: ExitCode;
  suites: SummarySuite[];
  /** The pass bars that were not reached, each in words. */
  belowBar: string[];
  /** How many finished runs are invalid. A run that did not run, because the command stopped, is not counted. */
  invalid: number;
  /** How many pairs of harness and case were not applicable. */
  notApplicable: number;
  /** Why the command stopped early: "budget", "duration", "interrupted" or "error"; null for a command that ran to the end. */
  partial: "budget" | "duration" | "interrupted" | "error" | null;
  /** The cost of every run, judge, decision and failed attempt that reported one; null when none did. */
  costUsd: number | null;
  /** The time of every run and failed attempt, added up. Runs in parallel overlap, so it is not wall time. */
  durationMs: number;
}

/**
 * Sums up a command for `summary.json`.
 * @param results - What `evaluate` wrote to `results.json`.
 * @param exit - The code the command exits with, as `exitCodeOf` decided it from `--max-invalid` and the results.
 * @returns What `summary.json` holds.
 */
export function summaryOf(results: Results, exit: ExitCode): Summary {
  const { records, partial } = results;
  const reason = partial?.reason;
  return {
    schemaVersion: 1,
    exit,
    suites: results.suites.flatMap((suite) =>
      results.subjects.map(({ label }) => ({
        harness: suite.harness,
        label,
        score: suite.suite[label] ?? null,
        applicable: suite.applicable,
        total: suite.total,
        validRuns: suite.runs[label]?.valid ?? 0,
        plannedRuns: suite.runs[label]?.planned ?? 0,
      })),
    ),
    belowBar: results.belowBar,
    invalid: invalidShare(results).invalid,
    notApplicable: results.notApplicable.length,
    partial: reason === undefined || reason === "running" ? null : reason,
    costUsd: costOf(records),
    durationMs: records.reduce(
      (sum, record) =>
        sum +
        record.durationMs +
        (record.attempts ?? []).reduce((mine, one) => mine + one.durationMs, 0),
      0,
    ),
  };
}
