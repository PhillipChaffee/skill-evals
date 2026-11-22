import type { Results } from "./evaluate.js";
import { invalidReason } from "./run.js";
import { UsageError } from "./scope.js";

/** What the process exits with. `docs/.../reference/exit-codes.md` is written from this table. */
export const EXIT = {
  ok: 0,
  bar: 1,
  usage: 2,
  invalid: 3,
  partial: 4,
  error: 5,
  interrupted: 130,
} as const;

/** What each exit code means, for the reference page. Every code of `EXIT` needs one. */
export const EXIT_MEANINGS: Record<keyof typeof EXIT, string> = {
  ok: "The command ran to the end, every case has a valid run, the invalid runs are within `--max-invalid`, and every pass bar is reached.",
  bar: "A pass bar was not reached: `--min-score`, a case's `minScore`, `--min-delta`, or a case's `minDelta`.",
  usage:
    "A wrong command line, case file, config file or subject, or an unsupported platform. One line on standard error, before any run. `validate` also exits 2 when it finds a problem.",
  invalid:
    "More of the planned runs are invalid than `--max-invalid` allows (default: any), a case has no valid run at all whatever `--max-invalid` says, or a subject directory changed while the command ran.",
  partial:
    "`--max-cost` or `--max-duration` stopped the command. Runs that never ran are not invalid. Continue with `--resume`.",
  error:
    "An internal failure that is not a usage error, including a report that could not be written, and an error that nothing caught. The stack trace is on standard error. `summary.json` says `partial` is `error`, with no suites when the failure came before the first run; `results.json` says so too when the failure came during or after the runs.",
  interrupted:
    "SIGINT or SIGTERM ended the command. The results so far are written first.",
};

/** One of the values of `EXIT`. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** The order in which codes win when several apply, first to last. */
export const PRECEDENCE: readonly ExitCode[] = [
  EXIT.usage,
  EXIT.interrupted,
  EXIT.error,
  EXIT.partial,
  EXIT.invalid,
  EXIT.bar,
];

// Absorbs float error, so that one invalid run in three is not above a budget of a third.
const EPSILON = 1e-9;

/**
 * The part of the results that decides the exit code: what `results.json` holds, and what `evaluate` returns.
 * `schemaVersion` is read only to name the version in an error.
 */
export type Exiting = Pick<
  Results,
  "partial" | "sourceChanged" | "belowBar" | "records" | "suites"
> & { schemaVersion?: number };

/**
 * Picks the exit code when several apply.
 * @param applying - The codes of every condition that holds; an order and repeats do not matter.
 * @returns The first of usage, interrupted, error, partial, invalid and bar that is among them; 0 when none is.
 */
export const strongest = (applying: readonly ExitCode[]): ExitCode =>
  PRECEDENCE.find((code) => applying.includes(code)) ?? EXIT.ok;

/**
 * Refuses results that were written before run counts existed.
 * @param results - What `results.json` holds.
 * @throws {UsageError} When a suite or case lacks `runs`, naming the schema version.
 */
function requireCounts(results: Exiting): void {
  const old = results.suites.some(
    (suite) =>
      (suite.runs as unknown) === undefined ||
      suite.cases.some((one) => (one.runs as unknown) === undefined),
  );
  if (old) {
    throw new UsageError(
      `these results lack the run counts of a newer version (schemaVersion ${String(results.schemaVersion ?? "none")}); score again`,
    );
  }
}

/**
 * Counts the invalid runs against the runs of the plan. A run that did not run, because the command stopped, is not
 * invalid.
 * @param results - What `evaluate` wrote to `results.json`.
 * @returns How many finished runs are invalid, and how many runs the plan holds over the cases that apply.
 * @throws {UsageError} When the results come from a version that did not write run counts.
 */
export function invalidShare(results: Exiting): {
  invalid: number;
  planned: number;
} {
  requireCounts(results);
  const invalid = results.records.filter(
    (record) =>
      invalidReason(record) !== null && record.skippedGraders !== true,
  ).length;
  const planned = results.suites.reduce(
    (sum, suite) =>
      sum +
      Object.values(suite.runs).reduce((mine, runs) => mine + runs.planned, 0),
    0,
  );
  return { invalid, planned };
}

/**
 * Tells whether any applicable case has no valid run for a subject: it has no score, whatever `--max-invalid` allows.
 * @param results - What `evaluate` wrote to `results.json`.
 * @returns True when a case that was planned has no valid run.
 */
const hasUnscoredCase = (results: Exiting): boolean =>
  results.suites.some((suite) =>
    suite.cases.some((one) =>
      Object.values(one.runs).some(
        (runs) => runs.planned > 0 && runs.valid === 0,
      ),
    ),
  );

/**
 * Tells whether the invalid runs are above the budget.
 * @param results - What `evaluate` wrote to `results.json`.
 * @param maxInvalid - The share of the planned runs that may be invalid, from 0 to 1.
 * @returns True when the invalid runs divided by the planned runs are greater than `maxInvalid`.
 */
export function overBudget(results: Exiting, maxInvalid: number): boolean {
  const { invalid, planned } = invalidShare(results);
  return planned > 0 && invalid / planned > maxInvalid + EPSILON;
}

/**
 * Decides the exit code of a command that ran. This one function serves the command line, `summary.json` and the
 * library, so that they cannot disagree.
 * @param results - What `evaluate` wrote to `results.json`; see `Exiting`.
 * @param maxInvalid - The share of the planned runs that may be invalid, from 0 to 1. Default: 0.
 * @returns 130 for an interrupt, 5 when a run threw, 4 when a limit stopped the command, 3 when a subject directory
 *   changed, the invalid runs are above `maxInvalid`, or a case has no valid run at all (a suite with no score is never
 *   a pass), 1 when a pass bar is missed, else 0. A usage error never reaches here: the command line raises it first.
 * @throws {UsageError} When `maxInvalid` is not a number from 0 to 1, or the results lack run counts.
 */
export function exitCodeOf(results: Exiting, maxInvalid = 0): ExitCode {
  if (!(maxInvalid >= 0 && maxInvalid <= 1)) {
    throw new UsageError("maxInvalid must be a number from 0 to 1");
  }
  requireCounts(results);
  const reason = results.partial?.reason;
  const applying: ExitCode[] = [];
  if (reason === "interrupted") applying.push(EXIT.interrupted);
  if (reason === "error") applying.push(EXIT.error);
  if (reason === "budget" || reason === "duration") applying.push(EXIT.partial);
  if (
    results.sourceChanged.length > 0 ||
    hasUnscoredCase(results) ||
    overBudget(results, maxInvalid)
  ) {
    applying.push(EXIT.invalid);
  }
  if (results.belowBar.length > 0) applying.push(EXIT.bar);
  return strongest(applying);
}
