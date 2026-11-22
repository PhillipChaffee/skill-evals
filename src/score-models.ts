import type { DecisionCheck, JudgedCheck, Outcome } from "./checks/index.js";
import type {
  DecisionCall,
  DecisionModel,
  DecisionResult,
} from "./decision.js";
import { decide } from "./decision.js";
import { judge } from "./judge.js";
import { materialFor } from "./judge-render.js";
import type { CheckResult, Usage } from "./run-plan.js";
import { bare } from "./run-plan.js";

/** What a model scores a run from. */
interface Material {
  /** The prompt the agent got. */
  task: string;
  outcome: Outcome;
}

/**
 * Sends the decision checks of a case to the decision model: one request for each distinct thing to see, so a check
 * that sees only the final answer never gets the transcript another check asked for.
 * @param run - The decision model and what to decide about.
 * @param run.model - The decision model.
 * @param checks - The case's decision checks.
 * @returns Each check's result, and every request's cost.
 */
export async function decideAll(
  run: Material & { model: DecisionModel },
  checks: DecisionCheck[],
): Promise<{
  results: Map<DecisionCheck, DecisionResult>;
  calls: DecisionCall[];
}> {
  const results = new Map<DecisionCheck, DecisionResult>();
  const calls: DecisionCall[] = [];
  const groups = new Map<string, DecisionCheck[]>();
  for (const check of checks) {
    const key = JSON.stringify([check.sees, check.files, check.maxChars]);
    groups.set(key, [...(groups.get(key) ?? []), check]);
  }
  for (const group of groups.values()) {
    const [first] = group;
    const decided = await decide(run.model, {
      task: run.task,
      answer: run.outcome.finalText,
      checks: group,
      ...(first?.sees === undefined
        ? {}
        : { seen: materialFor(first, run.outcome) }),
    });
    calls.push(...decided.calls);
    for (const [at, check] of group.entries()) {
      results.set(check, decided.results[at] as DecisionResult);
    }
  }
  return { results, calls };
}

/**
 * Scores one judge check.
 * @param ask - Sends a prompt to the judge.
 * @param run - The prompt the agent got, and what the run left behind.
 * @param check - The judge check.
 * @returns The check with its score, reason and, when it had several votes, each vote; and every reply it took.
 */
export async function judgedResult<
  Reply extends Usage & { finalText: string; error: string | null },
>(
  ask: (prompt: string) => Promise<Reply>,
  run: Material,
  check: JudgedCheck,
): Promise<{ result: CheckResult; replies: Reply[] }> {
  const verdict = await judge(ask, {
    task: run.task,
    answer: run.outcome.finalText,
    rubric: check.rubric,
    ...(check.scale === undefined ? {} : { scale: check.scale }),
    ...(check.votes === undefined ? {} : { votes: check.votes }),
    ...(check.sees === undefined
      ? {}
      : { seen: materialFor(check, run.outcome) }),
  });
  return {
    replies: verdict.replies,
    result: {
      ...bare(check),
      score: verdict.score,
      reason: verdict.reason,
      ...(verdict.votes ? { votes: verdict.votes } : {}),
    },
  };
}
