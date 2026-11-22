import type { Results } from "./evaluate.js";
import { invalidReason } from "./run.js";

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
  ok: "Every run is valid and every pass bar is reached.",
  bar: "A pass bar was not reached: `--min-score`, or a case's `minScore`.",
  usage:
    "A wrong command line, case file, config file or subject, or an unsupported platform. One line on standard error, before any run. `validate` also exits 2 when it finds a problem.",
  invalid:
    "More of the planned runs are invalid than `--max-invalid` allows (default: any), or a subject directory changed while the command ran. The message says which.",
  partial:
    "`--max-cost` or `--max-duration` stopped the command. Runs that never ran are not invalid. Continue with `--resume`.",
  error:
    "An internal failure that is not a usage error. The stack trace is on standard error, and `results.json` says `partial` is `error`.",
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

/** The part of the results that decides the exit code. */
export type Exiting = Pick<
  Results,
  "partial" | "sourceChanged" | "belowBar" | "records" | "suites"
>;

/**
 * Picks the exit code when several apply.
 * @param applying - The codes of every condition that holds; an order and repeats do not matter.
 * @returns The first of usage, interrupted, error, partial, invalid and bar that is among them; 0 when none is.
 */
export const strongest = (applying: readonly ExitCode[]): ExitCode =>
  PRECEDENCE.find((code) => applying.includes(code)) ?? EXIT.ok;

/**
 * Counts the invalid runs against the runs of the plan. A run that did not run, because the command stopped, is not
 * invalid.
 * @param results - What `evaluate` wrote to `results.json`.
 * @returns How many finished runs are invalid, and how many runs the plan holds over the cases that apply.
 */
export function invalidShare(results: Exiting): {
  invalid: number;
  planned: number;
} {
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
 * Decides the exit code of a command that ran. This one function serves the command line, `summary.json` and the
 * library, so that they cannot disagree.
 * @param results - What `evaluate` wrote to `results.json`.
 * @param maxInvalid - The share of the planned runs that may be invalid, from 0 to 1. Default: 0.
 * @returns 130 for an interrupt, 5 when a run threw, 4 when a limit stopped the command, 3 when a subject directory
 *   changed or the invalid runs are above `maxInvalid`, 1 when a pass bar is missed, else 0. A usage error never
 *   reaches here: the command line raises it before anything runs.
 */
export function exitCodeOf(results: Exiting, maxInvalid = 0): ExitCode {
  const { invalid, planned } = invalidShare(results);
  const reason = results.partial?.reason;
  const applying: ExitCode[] = [];
  if (reason === "interrupted") applying.push(EXIT.interrupted);
  if (reason === "error") applying.push(EXIT.error);
  if (reason === "budget" || reason === "duration") applying.push(EXIT.partial);
  if (
    results.sourceChanged.length > 0 ||
    (planned > 0 && invalid / planned > maxInvalid + EPSILON)
  ) {
    applying.push(EXIT.invalid);
  }
  if (results.belowBar.length > 0) applying.push(EXIT.bar);
  return strongest(applying);
}
