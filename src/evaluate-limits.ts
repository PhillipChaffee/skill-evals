import type { Case } from "./cases.js";
import { isDecision, isJudged } from "./checks/index.js";
import type { Limits } from "./gate.js";
import type { Located } from "./harnesses/index.js";
import type { JudgeApi } from "./judge-api.js";
import type { Config } from "./project.js";
import { UsageError } from "./scope.js";

const MS_PER_MINUTE = 60_000;

/** What `maxCost` needs to know of the command. */
export interface Spending {
  /** The harnesses under test. */
  chosen: Located[];
  /** The harness that scores judged checks; undefined when each harness judges for itself. */
  judgeHarness: Located | undefined;
  /** The judge API; null when the judge is a harness session, or no case has a judge check. */
  judgeApi: JudgeApi | null;
  /** The selected cases. */
  cases: Case[];
}

/**
 * Checks that every part of a command reports a cost, so that `maxCost` counts all of it.
 * @param spending - The harnesses, the judge path and the cases.
 * @throws {UsageError} When a selected harness reports no cost, when the judge cannot report one (the judge API reports
 *   none, and neither does a judge harness that does not), or when a case has a decision check, which reports none.
 */
function requireCosts(spending: Spending): void {
  const { chosen, judgeHarness, judgeApi, cases } = spending;
  const blind = chosen.filter(({ harness }) => !harness.reportsCost);
  if (blind.length > 0) {
    const names = blind.map(({ harness }) => harness.id).join(", ");
    throw new UsageError(
      `maxCost needs every harness to report its cost, and ${names} does not: leave out --max-cost, or choose other harnesses`,
    );
  }
  const judging = cases.some((one) => one.checks.some(isJudged));
  const judges = judgeHarness ? [judgeHarness] : chosen;
  if (judgeApi !== null) {
    throw new UsageError(
      "maxCost cannot count the judge API, which reports no cost: leave out --max-cost, or judge with a harness",
    );
  }
  const unjudged = judges.find(({ harness }) => !harness.reportsCost);
  if (judging && unjudged) {
    throw new UsageError(
      `maxCost cannot count the judge: ${unjudged.harness.id} reports no cost`,
    );
  }
  if (cases.some((one) => one.checks.some(isDecision))) {
    throw new UsageError(
      "maxCost cannot count decision checks, which report no cost: leave out --max-cost, or select no decision case",
    );
  }
}

/**
 * Reads a positive number.
 * @param name - The option, for the message.
 * @param value - What the option holds; undefined when it is not set.
 * @param unit - What the number counts, for the message.
 * @returns The number; undefined when the option is not set.
 * @throws {UsageError} When it is set and is not a finite number above 0.
 */
function positive(
  name: string,
  value: number | undefined,
  unit: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${name} must be a positive number of ${unit}`);
  }
  return value;
}

/**
 * Reads the retries and the cost and time limits of a command.
 * @param options - The options after the config file was applied.
 * @param spending - The harnesses, the judge path and the cases, which `maxCost` needs to count.
 * @returns The limits; `retries` is 0 when it is not set, and a limit that is not set is undefined.
 * @throws {UsageError} When `retries` is not a non-negative integer, `maxCost` or `maxDuration` is not a positive number,
 *   or `maxCost` is set and part of the command reports no cost.
 */
export function requireLimits(options: Config, spending: Spending): Limits {
  const { retries = 0 } = options;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new UsageError("retries must be a non-negative integer");
  }
  const maxCost = positive("maxCost", options.maxCost, "US dollars");
  const minutes = positive("maxDuration", options.maxDuration, "minutes");
  if (maxCost !== undefined) requireCosts(spending);
  return {
    retries,
    maxCost,
    maxDurationMs: minutes === undefined ? undefined : minutes * MS_PER_MINUTE,
  };
}
