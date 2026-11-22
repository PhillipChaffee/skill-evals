import type { DecisionCheck, JudgedCheck, Outcome } from "./checks/index.js";
import type {
  DecisionCall,
  DecisionModel,
  DecisionResult,
} from "./decision.js";
import { decide } from "./decision.js";
import type { Cache } from "./cache.js";
import { memoOf } from "./cache.js";
import { judge } from "./judge.js";
import type { Attachment } from "./judge-api.js";
import { imagesOf } from "./judge-images.js";
import { materialFor } from "./judge-render.js";
import type { CheckResult, Usage } from "./run-plan.js";

/** What a model scores a run from. */
interface Material {
  /** The prompt the agent got. */
  task: string;
  outcome: Outcome;
}

/** How the judge is reached. */
export interface Via {
  /** Whether image files go with the prompt (the API path); otherwise they are named and not shown. */
  images: boolean;
  /** What the judge has answered before; none for no cache. */
  cache: Cache | null;
  /** The judge's model, for the cache key; empty when the harness picks. */
  model: string;
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
    // No `sees` and `["final"]` see the same thing, so they share a request.
    const key = JSON.stringify([
      check.sees ?? ["final"],
      check.files,
      check.maxChars,
    ]);
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
 * @param run - The prompt the agent got, what the run left behind, and how the judge is reached.
 * @param check - The judge check.
 * @returns The check with its score, reason and, when it had several votes, each ballot; every reply it took; and how
 *   many votes the cache answered.
 */
export async function judgedResult<
  Reply extends Usage & { finalText: string; error: string | null },
>(
  ask: (prompt: string, attachments: Attachment[]) => Promise<Reply>,
  run: Material & Via,
  check: JudgedCheck,
): Promise<{ result: CheckResult; replies: Reply[]; hits: number }> {
  const attachments =
    run.images && check.sees?.includes("files")
      ? imagesOf(check.files ?? [], run.outcome.workspace)
      : [];
  const scale = check.scale ?? "0-1";
  const memo = run.cache
    ? memoOf(run.cache, { model: run.model, attachments, scale })
    : undefined;
  const verdict = await judge<Reply>(
    ask,
    {
      task: run.task,
      answer: run.outcome.finalText,
      rubric: check.rubric,
      ...(check.scale === undefined ? {} : { scale: check.scale }),
      ...(check.votes === undefined ? {} : { votes: check.votes }),
      ...(check.sees === undefined
        ? {}
        : { seen: materialFor(check, run.outcome, attachments) }),
      attachments,
    },
    memo,
  );
  return {
    replies: verdict.replies,
    hits: verdict.hits ?? 0,
    result: {
      ...check,
      score: verdict.score,
      reason: verdict.reason,
      ...(verdict.ballots ? { ballots: verdict.ballots } : {}),
    },
  };
}
