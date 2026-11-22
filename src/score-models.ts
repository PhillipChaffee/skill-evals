import type { DecisionCheck, JudgedCheck, Outcome } from "./checks/index.js";
import type {
  DecisionCall,
  DecisionModel,
  DecisionResult,
} from "./decision.js";
import { decide } from "./decision.js";
import type { Cache } from "./cache.js";
import { cacheKey, memoOf } from "./cache.js";
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
  /** The judge harness's id, or "api", for the cache key. */
  path: string;
}

/**
 * Names one request to the decision model in the cache.
 * @param run - What the model scores a run from, and its id.
 * @param run.task - The prompt the agent got.
 * @param run.outcome - What the run left behind.
 * @param run.modelId - The id of the model that is asked.
 * @param group - The checks that the request carries.
 * @returns The cache key.
 */
function decisionKey(
  run: Material & { modelId?: string | undefined },
  group: DecisionCheck[],
): string {
  const [first] = group;
  return cacheKey({
    prompt: JSON.stringify([
      run.task,
      run.outcome.finalText,
      first?.sees === undefined ? null : materialFor(first, run.outcome),
      group.map((one) => [one.question, one.expect, one.options]),
    ]),
    attachments: [],
    model: run.modelId ?? "",
    scale: "0-1",
    vote: 0,
    via: "decision",
  });
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
  run: Material & {
    model: DecisionModel;
    /** What decision answers are kept in, by slot; none for no cache. */
    cache?: Cache | null | undefined;
    /** The decision model's id, for the cache key. */
    modelId?: string | undefined;
  },
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
    const key = decisionKey(run, group);
    const hit = run.cache?.get(key)?.decision;
    if (hit?.length === group.length) {
      for (const [at, check] of group.entries()) {
        results.set(check, hit[at] as DecisionResult);
      }
      continue;
    }
    const decided = await decide(run.model, {
      task: run.task,
      answer: run.outcome.finalText,
      checks: group,
      ...(first?.sees === undefined
        ? {}
        : { seen: materialFor(first, run.outcome) }),
    });
    calls.push(...decided.calls);
    if (decided.results.every((one) => one.score !== null)) {
      run.cache?.set(key, {
        score: 0,
        reason: "",
        usage: { durationMs: 0, tokens: null, costUsd: null },
        decision: decided.results,
      });
    }
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
    ? memoOf(run.cache, {
        model: run.model,
        via: run.path,
        attachments,
        scale,
      })
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
