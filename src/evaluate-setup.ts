import { connect } from "./baseten.js";
import type { Case } from "./cases.js";
import type { EvaluateOptions } from "./evaluate.js";
import type { SelectionOptions } from "./select.js";
import { loadSelection, selectionOf } from "./select.js";
import type { Label } from "./subject.js";
import { requireNamed } from "./subject-labels.js";
import { isDecision } from "./checks/index.js";
import type { DecisionService } from "./decision.js";
import { requireEnvNames } from "./env.js";
import type { HistoryMode } from "./history-types.js";
import { HISTORY_MODES } from "./history-types.js";
import type { NoiseFile } from "./noise.js";
import { readNoise } from "./noise.js";
import type { Config } from "./project.js";
import { MAX_SEED, isSeed } from "./project.js";
import { isUnitScore } from "./score.js";
import { MS_PER_SECOND, requireSeconds } from "./seconds.js";
import { UsageError } from "./scope.js";

const DEFAULT_REPS = 3;
// A comparison has at least two subjects.
const COMPARED = 2;
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
 * Reads the share of the planned runs that may be invalid.
 * @param options - The options after the config file was applied.
 * @returns `maxInvalid`; 0 when it is not set.
 * @throws {UsageError} When it is not a number from 0 to 1.
 */
export function requireMaxInvalid(options: Config): number {
  const { maxInvalid = 0 } = options;
  if (!isUnitScore(maxInvalid)) {
    throw new UsageError("maxInvalid must be a number from 0 to 1");
  }
  return maxInvalid;
}

/** What a comparison is judged with. */
export interface DeltaSetup {
  /** The bar for the suite delta; undefined for none. */
  minDelta: number | undefined;
  /** The seed of the bootstrap. */
  seed: number;
  /** True when `minDelta` was set and one subject has no delta to hold to it: it is ignored, and the report says so. */
  ignored: boolean;
  /** The noise file and where it was read from; null for none. */
  noise: { file: string; noise: NoiseFile } | null;
}

/**
 * Reads the options that only a comparison of two subjects uses, and refuses them for one subject.
 * @param options - The options after the config file was applied.
 * @param shape - How many subjects there are, and whether they are one subject run against itself.
 * @param shape.subjects - The number of subjects: 1 to 8.
 * @param shape.same - True for `calibrate`, which measures the noise and so ignores a bar and a noise file.
 * @returns The bar, the seed (default 1) and the noise file. With one subject a `minDelta` of the config is ignored.
 * @throws {UsageError} When `minDelta` is not from -1 to 1, when `seed` is not a positive
 *   integer up to 4294967295, or when the noise file is not one.
 */
export function requireDeltaSetup(
  options: Config,
  shape: { subjects: number; same: boolean },
): DeltaSetup {
  const { minDelta, seed = 1, noise: file } = options;
  if (!isSeed(seed)) {
    throw new UsageError(
      `seed must be a positive integer up to ${String(MAX_SEED)}`,
    );
  }
  if (minDelta !== undefined) {
    if (!(minDelta >= -1 && minDelta <= 1)) {
      throw new UsageError("minDelta must be a number from -1 to 1");
    }
  }
  const compared = shape.subjects >= COMPARED && !shape.same;
  return {
    minDelta: compared ? minDelta : undefined,
    ignored: minDelta !== undefined && shape.subjects < COMPARED,
    seed,
    noise:
      compared && file !== undefined ? { file, noise: readNoise(file) } : null,
  };
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

/**
 * Reads how many runs may be in flight at once.
 * @param options - The options after the config file was applied.
 * @returns `jobs`; 1 when it is not set.
 * @throws {UsageError} When it is not a positive integer.
 */
export function requireJobs(options: Config): number {
  const { jobs = 1 } = options;
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new UsageError("jobs must be a positive integer");
  }
  return jobs;
}

/**
 * Reads how a case's history reaches the agent.
 * @param options - The options after the config file was applied.
 * @returns `historyMode`; undefined when it is not set, which leaves each harness its own mode.
 * @throws {UsageError} When it is neither "native" nor "preamble".
 */
export function requireHistoryMode(options: Config): HistoryMode | undefined {
  const { historyMode } = options;
  if (historyMode === undefined) return undefined;
  const known = HISTORY_MODES.find((mode) => mode === historyMode);
  if (known === undefined) {
    throw new UsageError(
      `historyMode must be one of ${HISTORY_MODES.join(", ")}, not "${historyMode}"`,
    );
  }
  return known;
}

/**
 * Pairs each subject with its label.
 * @param specs - What the caller passed as `subjects`.
 * @param names - The labels that `--subjects` gave, one for each spec; absent for `--a`, `--b` and `--subject`.
 * @returns With names, each subject under its own; else "subject" for one, and "a" for the baseline and "b" for the
 *   subject under test for two.
 * @throws {UsageError} When there are not one or two subjects without names, or the names are not 2 to 8 distinct labels.
 */
export function labelled(
  specs: string[],
  names?: string[],
): { label: Label; spec: string }[] {
  if (names !== undefined) {
    return requireNamed(
      specs.map((spec, at) => ({ label: names[at] ?? "", spec })),
    );
  }
  const [first, second, ...more] = Array.isArray(specs) ? specs : [];
  if (first === undefined || more.length > 0) {
    throw new UsageError("subjects must hold one or two subjects");
  }
  return second === undefined
    ? [{ label: "subject", spec: first }]
    : [
        { label: "a", spec: first },
        { label: "b", spec: second },
      ];
}

/**
 * Loads the cases the options name.
 * @param options - The options after the config file was applied.
 * @returns The cases that the selection options choose.
 */
export const casesOf = (
  options: SelectionOptions &
    Pick<EvaluateOptions, "lenient" | "onWarning"> & { cases: string },
): Case[] =>
  loadSelection(options.cases, selectionOf(options), {
    lenient: options.lenient ?? false,
    ...(options.onWarning && { onWarning: options.onWarning }),
  });
