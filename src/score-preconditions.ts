import type { Check, RuledCheck, Verdict } from "./checks/index.js";
import { describeCheck } from "./checks/index.js";
import type { CheckResult } from "./run-plan.js";

// Why a run's judged, decision and command checks are left alone when it is invalid for another reason.
const INVALID = "the run is invalid";

/**
 * Scores the preconditions of a case, before any other check that a model or a command scores.
 * @param checks - The case's `preconditions`.
 * @param score - Scores one rule check, as the case's own checks are scored.
 * @param valid - False when the run is already invalid, whose first reason stays the run's.
 * @returns Each precondition with its score, in the case's order; whether the judged, decision and command checks may
 *   be run; and why they may not. A precondition that scores 0, or has no score, is not met.
 */
export async function scorePreconditions(
  checks: Check[],
  score: (check: RuledCheck) => Promise<Verdict>,
  valid: boolean,
): Promise<{ results: CheckResult[]; judgeable: boolean; because: string }> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    // A load only lets a rule check in, so the cast holds.
    results.push({ ...check, ...(await score(check as RuledCheck)) });
  }
  const failed = results.find((result) => !result.score);
  return {
    results,
    judgeable: valid && failed === undefined,
    because:
      valid && failed !== undefined
        ? `precondition not met: ${describeCheck(failed)}`
        : INVALID,
  };
}
