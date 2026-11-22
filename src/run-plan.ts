import type { Case } from "./cases.js";
import type { Check, Verdict } from "./checks/index.js";
import type { DecisionService } from "./decision.js";
import type { Harness, Tokens } from "./harnesses/shared.js";
import type { Subject } from "./subject.js";

/** What a session cost. A number the harness does not report is null. */
export interface Usage {
  durationMs: number;
  tokens: Tokens | null;
  costUsd: number | null;
}

// A check's `votes` is how many judge calls to make; its result's `votes` is what they gave.
type WithoutVotes<T> = T extends unknown ? Omit<T, "votes"> : never;

/** A check with what it gave one run. */
export type CheckResult = WithoutVotes<Check> & {
  /** Null when a judged check, a decision check or a command check got no usable answer. */
  score: number | null;
  /** The judge's reason, or why there is no score. */
  reason?: string;
  /** For a judge check with `votes` above 1: what each vote gave. A vote with no usable answer has a null score. */
  votes?: { score: number | null; reason: string }[];
  /** For a decision check, the probability the model gave each allowed answer. */
  probabilities?: Record<string, number>;
  /** For a command check: what the command did, each stream cut to its last 2,000 bytes. */
  command?: Verdict["command"];
};

/**
 * Makes a check ready to carry a result: a judge check's `votes` is how many calls to make, and its result's is what
 * they gave, so the count is dropped.
 * @param check - Any check of a case.
 * @returns The check, without `votes`.
 */
export function bare(check: Check): WithoutVotes<Check> {
  if (check.type !== "judge") return check;
  const rest = { ...check };
  delete rest.votes;
  return rest;
}

/** The harness and model that score judged checks. */
export interface Judge {
  harness: Harness;
  bin: string;
  model?: string | undefined;
}

/** One run to make: one case, one harness, one subject. */
export interface RunPlan {
  harness: Harness;
  bin: string;
  subject: Subject;
  caseDef: Case;
  rep: number;
  model?: string | undefined;
  judge: Judge;
  /** Start the harness with nothing loaded but the subject, and invalidate a run that reports anything else. */
  isolated?: boolean | undefined;
  /** Keep the 0.0.1 rule for `skill_loaded` and `skill_not_loaded` (`--lenient`). */
  lenient?: boolean | undefined;
  /** Names of variables the harness gets besides the allowlist: the config's `env`. */
  pass?: string[] | undefined;
  /** The model that scores decision checks; null when no case has one. */
  decision: DecisionService | null;
  /** Where the run's stream and final text are written. */
  outDir: string;
}

/**
 * Names what no harness process of a run may get.
 * @param plan - The run.
 * @returns The decision model's key, when there is a decision model.
 */
export const withheld = (plan: RunPlan): string[] =>
  plan.decision ? [plan.decision.secret] : [];
