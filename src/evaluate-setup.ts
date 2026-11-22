import { connect } from "./baseten.js";
import type { Case } from "./cases.js";
import { isDecision } from "./checks/index.js";
import type { DecisionService } from "./decision.js";
import { requireEnvNames } from "./env.js";
import type { Config } from "./project.js";
import { isUnitScore } from "./score.js";
import { MS_PER_SECOND, requireSeconds } from "./seconds.js";
import { UsageError } from "./scope.js";

const DEFAULT_REPS = 3;
/**
 * Rejects option values that no run could use, before any harness starts.
 * @param options - The options after the config file was applied.
 * @returns The number of runs for each subject and case.
 * @throws {UsageError} When `reps`, `minScore`, or `decisionTimeout` is out of range.
 */
export function requireUsable(options: Config): number {
  const { reps = DEFAULT_REPS, minScore, decisionTimeout: seconds } = options;
  requireEnvNames(options.env ?? [], "env");
  if (!Number.isInteger(reps) || reps < 1) {
    throw new UsageError("reps must be a positive integer");
  }
  if (minScore !== undefined && !isUnitScore(minScore)) {
    throw new UsageError("minScore must be a number from 0 to 1");
  }
  if (seconds !== undefined) requireSeconds("decisionTimeout", seconds);
  return reps;
}

/**
 * Connects to the decision model when a case needs one, before any harness starts.
 * @param cases - The cases of the suite.
 * @param options - The options after the config file was applied.
 * @returns The decision model, or null when no case has a decision check.
 * @throws {UsageError} When a case has a decision check and the model or its API key is not set.
 */
export function decisionFor(
  cases: Case[],
  options: Config,
): DecisionService | null {
  if (!cases.some((caseDef) => caseDef.checks.some(isDecision))) return null;
  const { decisionModel: model, decisionUrl: url } = options;
  const { decisionTimeout: seconds } = options;
  if (!model) {
    throw new UsageError(
      "a case has a decision check, but no decision model is set: pass --decision-model or set decisionModel in the config file",
    );
  }
  const timeoutMs = seconds === undefined ? undefined : seconds * MS_PER_SECOND;
  return connect({ model, url, env: process.env, timeoutMs });
}
