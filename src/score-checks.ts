import type {
  Check,
  DecisionCheck,
  JudgedCheck,
  Outcome,
  RuledCheck,
  Verdict,
} from "./checks/index.js";
import { checkScore, isDecision, isJudged } from "./checks/index.js";
import { mockLogVerdict } from "./checks/mock-log.js";
import { OverBudget, budgeted } from "./checks/big-match.js";
import { removeLogin } from "./command.js";
import type { Via } from "./score-models.js";
import { decideAll, judgedResult } from "./score-models.js";
import type { CheckResult, ScoringPlan, Usage } from "./run-plan.js";
import { withheld } from "./run-plan.js";
import { messageOf } from "./scope.js";
import { judgeAsker } from "./startup.js";
import type { Confinement } from "./os-sandbox.js";
import { maskingOf } from "./sandbox-masks.js";
import { apiAsker } from "./judge-api.js";
import { notScoredFor, viewFor } from "./turn-outcome.js";
import { scorePreconditions } from "./score-preconditions.js";

// A decision check that no request was sent for: only a valid run is decided, and a suite with decision checks
// does not start without a decision model.
const notDecided = (because: string) => ({
  score: null,
  reason: `not decided, because ${because}`,
});
// A command check on a run that is already invalid: the commands run on a valid run only, so a harness error stays the
// run's first reason and no command touches what a broken run left behind.
const notRun = (because: string) => ({
  score: null,
  reason: `not run, because ${because}`,
});
/**
 * Scores a check by its rule. A rule that throws, such as a user's regular expression that overflows the stack, scores
 * its check 0 and leaves the run valid. A pattern's test of a text over 16 KB runs in a worker thread, so that it
 * cannot block the other runs; one that takes longer than its budget leaves the check unscored, and the run invalid.
 * @param check - A check that a rule scores.
 * @param outcome - What the run left behind. A check of a turn reads that turn's slice of it.
 * @returns The rule's verdict, or 0 with the message that the rule threw, or 0 with the reason a turn did not run, or
 *   no score with the reason the pattern ran out of time.
 */
async function ruled(
  check: RuledCheck,
  outcome: Outcome,
): Promise<Verdict | { score: null; reason: string }> {
  const view = viewFor(check, outcome);
  if (typeof view === "string") return { score: 0, reason: view };
  try {
    return await budgeted(() => checkScore(check, view));
  } catch (error) {
    if (error instanceof OverBudget) {
      return { score: null, reason: error.message };
    }
    return {
      score: 0,
      reason: `the check could not be scored: ${messageOf(error)}`,
    };
  }
}

/**
 * Scores a check by its rule, unless the run holds calls that only the mock log showed and the check needs the agent,
 * the order or the turn of one: such a call has none of them, so the check is not scored.
 * @param check - A check that a rule scores.
 * @param outcome - What the run left behind.
 * @returns The mock log's verdict where it applies, else the rule's.
 */
async function ruledOrLog(check: RuledCheck, outcome: Outcome) {
  return mockLogVerdict(check, outcome) ?? (await ruled(check, outcome));
}

/**
 * Runs the command checks of a case, in case order, once everything else is scored.
 * @param plan - The run, whose case holds the checks and whose harness names the login files.
 * @param run - What the commands look at, and whether the run is still valid.
 * @param run.outcome - What the run left behind.
 * @param run.judgeable - False when the run is already invalid, or a precondition is not met: the commands are not run.
 * @param run.because - Why, for the reason of a check that was not run.
 * @param slots - The results by place in the case; each command's place is filled in.
 */
async function runCommands(
  plan: ScoringPlan,
  run: { outcome: Outcome; judgeable: boolean; because: string },
  slots: (CheckResult | undefined)[],
): Promise<void> {
  const { checks } = plan.caseDef;
  const stuck =
    run.judgeable && checks.some((check) => check.type === "command")
      ? removeLogin(plan.harness.authFiles, run.outcome.home)
      : null;
  for (const [index, check] of checks.entries()) {
    if (check.type !== "command" || slots[index] !== undefined) continue;
    const refused = {
      score: 0,
      reason: `the login could not be removed from the home: ${String(stuck)}`,
    };
    const verdict = !run.judgeable
      ? notRun(run.because)
      : stuck === null
        ? await ruled(check, run.outcome)
        : refused;
    slots[index] = { ...check, ...verdict };
  }
}

/**
 * Confines the judge's process as the agent's is, under `--sandbox`: the same masks, and the network open, since the
 * judge must reach its model.
 * @param plan - The run.
 * @returns The sandbox; undefined without `--sandbox`.
 */
function judgeSandbox(plan: ScoringPlan): Confinement | undefined {
  const { sandbox, outDir } = plan;
  if (sandbox === undefined || outDir === undefined) return undefined;
  return {
    backend: sandbox.backend,
    network: "open",
    ...maskingOf({
      ...plan,
      outDir,
      bin: plan.judge.bin,
      expose: plan.sandboxExpose,
    }),
  };
}

/**
 * Chooses how the judge is reached for a run.
 * @param plan - The run: its judge API or its judge harness, its cache, and the case's own `judgeModel`.
 * @param problems - Receives why a judge session does not prove it loaded nothing.
 * @returns The function that asks the judge, and what the scoring of a judge check needs to know of it.
 */
function judgeOf(plan: ScoringPlan, problems: string[]) {
  const { judgeApi, caseDef } = plan;
  const model = caseDef.judgeModel ?? (judgeApi ?? plan.judge).model;
  const ask = judgeApi
    ? apiAsker({ ...judgeApi, model: model ?? judgeApi.model })
    : judgeAsker(
        { ...plan.judge, model },
        {
          isolated: plan.isolated ?? false,
          withhold: withheld(plan),
          pass: plan.pass,
          sandbox: judgeSandbox(plan),
        },
        problems,
      );
  const via: Via = {
    images: judgeApi !== undefined,
    cache: plan.cache ?? null,
    model: model ?? "",
    path: judgeApi ? "api" : plan.judge.harness.id,
  };
  return { ask, via };
}

const skipped = (reason: string) => ({ score: null, reason });

/**
 * Scores one judged check, or leaves it unscored.
 * @param run - The run: its plan, how to ask the judge, and what the judge sees.
 * @param run.plan - Tells, through `breached`, whether a limit of the command is reached.
 * @param run.ask - Sends one request to the judge.
 * @param run.via - The judge's path, model and cache, which the scoring keys its answers by.
 * @param run.task - The case's prompt (`prompt.md`, or its turns written as one text). It is not the text that was sent: under
 *   `preamble` the history block in front of turn 1 is not part of it. The judge sees no history in this release.
 * @param run.outcome - What the judge reads of the run.
 * @param run.judgeable - False when the run is already invalid, or a precondition is not met.
 * @param run.because - Why, for the reason of a check that was not asked.
 * @param check - The check to score.
 * @param scored - Receives the judge's replies and cache hits, and whether the check was skipped.
 * @returns The check with its score; none when the run is invalid or a limit of the command is reached.
 */
async function judgedSlot(
  run: {
    plan: ScoringPlan;
    ask: ReturnType<typeof judgeOf>["ask"];
    via: Via;
    task: string;
    outcome: Outcome;
    judgeable: boolean;
    because: string;
  },
  check: JudgedCheck,
  scored: Scored,
): Promise<CheckResult> {
  if (!run.judgeable) {
    return {
      ...check,
      score: null,
      reason: `not judged, because ${run.because}`,
    };
  }
  const reason = skippedFor(run.plan);
  if (reason !== null) {
    scored.skipped = true;
    return { ...check, ...skipped(reason) };
  }
  const { ask, via, task, outcome } = run;
  const judged = await judgedResult(ask, { task, outcome, ...via }, check);
  scored.replies.push(...judged.replies);
  scored.hits += judged.hits;
  return judged.result;
}

/**
 * Says why the judged and decision checks of a run are not asked, when a cost or time limit of the command is reached.
 * @param plan - The run, whose `breached` tells.
 * @returns The reason to put on the checks; null when they may be asked.
 */
function skippedFor(plan: ScoringPlan): string | null {
  const reached = plan.breached?.(0) ?? null;
  return reached === null ? null : `skipped: ${reached} reached`;
}

/**
 * Starts the results of a case: a check of a reply turn that was not asked is left out of the score, whatever its type.
 * @param checks - Every check of the case.
 * @param outcome - What the run left behind.
 * @returns One slot for each check: its result without a score for a check that was not asked, and undefined for the
 *   others, which the scoring fills in.
 */
function unaskedSlots(
  checks: Check[],
  outcome: Outcome,
): (CheckResult | undefined)[] {
  return checks.map((check) => {
    const reason = notScoredFor(check, outcome);
    return reason === null
      ? undefined
      : { ...check, score: null, reason, notScored: true };
  });
}

/**
 * Asks the decision model about the decision checks of a case, in one request.
 * @param plan - The run, which names the decision model and the cache.
 * @param run - What the model is shown.
 * @param run.task - The case's prompt.
 * @param run.outcome - What the run left behind.
 * @param decisions - The decision checks of the case.
 * @returns The answers; null when the case has no decision check or no decision model is set.
 */
async function decideChecks(
  plan: ScoringPlan,
  run: { task: string; outcome: Outcome },
  decisions: DecisionCheck[],
) {
  if (!plan.decision || decisions.length === 0) return null;
  return decideAll(
    {
      model: plan.decision.model,
      ...run,
      cache: plan.cache ?? null,
      modelId: plan.decisionModel,
    },
    decisions,
  );
}

/** What the checks of a run besides its commands got. */
interface Scored {
  replies: Usage[];
  hits: number;
  /** True when a judged or decision check was left unasked because a limit was reached. */
  skipped: boolean;
}

/**
 * Scores every check of a case for one run.
 * @param plan - The run; its judge scores the judged checks, with nothing loaded and a prompt that carries nothing
 *   about the subject. Its `breached` tells whether a limit of the command is reached: a judged or decision check is
 *   then not asked and has no score, with the reason "skipped: budget reached" or "skipped: duration reached". Every
 *   other check is scored.
 * @param outcome - What the deterministic checks observe.
 * @param judgeableRun - False when the run is already invalid, which leaves the judged checks without a score. A case's
 *   `preconditions` are scored first; one that is not met does the same, with its own reason.
 * @returns The check results in case order, every reply of the judge, and every request to the decision model.
 */
export async function scoreChecks(
  plan: ScoringPlan,
  outcome: Outcome,
  judgeableRun: boolean,
): Promise<{
  checks: CheckResult[];
  replies: Usage[];
  requests: Usage[];
  judgeProblem: string | null;
  /** How many judge votes the cache answered. */
  hits: number;
  /** True when a judged or decision check was skipped because a limit of the command was reached. */
  skippedGraders: boolean;
  /** The case's preconditions with their scores, in case order; empty for a case with none. */
  preconditions: CheckResult[];
}> {
  const { prompt: task, checks: asked } = plan.caseDef;
  // Preconditions are scored first. One that is not met leaves the judged, decision and command checks unasked, so no
  // judge or command is spent on a run that cannot count.
  const pre = await scorePreconditions(
    plan.caseDef.preconditions ?? [],
    (check) => ruled(check, outcome),
    judgeableRun,
  );
  const { judgeable, because } = pre;
  const problems: string[] = [];
  const { ask, via } = judgeOf(plan, problems);
  const scored: Scored = { replies: [], hits: 0, skipped: false };
  // One request carries every decision check of the case.
  const decisions = asked.filter(isDecision);
  const early = judgeable && decisions.length ? skippedFor(plan) : null;
  const decided =
    judgeable && early === null
      ? await decideChecks(plan, { task, outcome }, decisions)
      : null;
  const slots = unaskedSlots(asked, outcome);
  // Commands run last: they may change the files that the other checks read, and a login must not be readable by
  // them. The record keeps the case's order.
  for (const [index, check] of asked.entries()) {
    if (check.type === "command" || slots[index] !== undefined) continue;
    if (isDecision(check)) {
      const result = decided?.results.get(check);
      const left =
        result ?? (early === null ? notDecided(because) : skipped(early));
      scored.skipped ||= result === undefined && early !== null;
      slots[index] = { ...check, ...left };
    } else if (!isJudged(check)) {
      slots[index] = { ...check, ...(await ruledOrLog(check, outcome)) };
    } else {
      slots[index] = await judgedSlot(
        { plan, ask, via, task, outcome, judgeable, because },
        check,
        scored,
      );
    }
  }
  await runCommands(plan, { outcome, judgeable, because }, slots);
  const checks = slots.filter((slot) => slot !== undefined);
  return {
    checks,
    replies: scored.replies,
    requests: decided?.calls ?? [],
    judgeProblem: problems[0] ?? null,
    hits: scored.hits,
    skippedGraders: scored.skipped,
    preconditions: pre.results,
  };
}
