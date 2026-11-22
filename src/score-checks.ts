import type {
  JudgedCheck,
  Outcome,
  RuledCheck,
  Verdict,
} from "./checks/index.js";
import { checkScore, isDecision, isJudged } from "./checks/index.js";
import { removeLogin } from "./command.js";
import type { Via } from "./score-models.js";
import { decideAll, judgedResult } from "./score-models.js";
import type { CheckResult, RunPlan, Usage } from "./run-plan.js";
import { withheld } from "./run-plan.js";
import { messageOf } from "./scope.js";
import { judgeAsker } from "./startup.js";
import { apiAsker } from "./judge-api.js";

// A decision check that no request was sent for: only a valid run is decided, and a suite with decision checks
// does not start without a decision model.
const NOT_DECIDED = {
  score: null,
  reason: "not decided, because the run is invalid",
};
// A command check on a run that is already invalid: the commands run on a valid run only, so a harness error stays the
// run's first reason and no command touches what a broken run left behind.
const NOT_RUN = {
  score: null,
  reason: "not run, because the run is invalid",
};
/**
 * Scores a check by its rule. A rule that throws, such as a user's regular expression that overflows the stack, scores
 * its check 0 and leaves the run valid.
 * @param check - A check that a rule scores.
 * @param outcome - What the run left behind.
 * @returns The rule's verdict, or 0 with the message that the rule threw.
 */
async function ruled(check: RuledCheck, outcome: Outcome): Promise<Verdict> {
  try {
    return await checkScore(check, outcome);
  } catch (error) {
    return {
      score: 0,
      reason: `the check could not be scored: ${messageOf(error)}`,
    };
  }
}

/**
 * Runs the command checks of a case, in case order, once everything else is scored.
 * @param plan - The run, whose case holds the checks and whose harness names the login files.
 * @param run - What the commands look at, and whether the run is still valid.
 * @param run.outcome - What the run left behind.
 * @param run.judgeable - False when the run is already invalid: the commands are not run.
 * @param slots - The results by place in the case; each command's place is filled in.
 */
async function runCommands(
  plan: RunPlan,
  run: { outcome: Outcome; judgeable: boolean },
  slots: (CheckResult | undefined)[],
): Promise<void> {
  const { checks } = plan.caseDef;
  const stuck =
    run.judgeable && checks.some((check) => check.type === "command")
      ? removeLogin(plan.harness.authFiles, run.outcome.home)
      : null;
  for (const [index, check] of checks.entries()) {
    if (check.type !== "command") continue;
    const refused = {
      score: 0,
      reason: `the login could not be removed from the home: ${String(stuck)}`,
    };
    const verdict = !run.judgeable
      ? NOT_RUN
      : stuck === null
        ? await ruled(check, run.outcome)
        : refused;
    slots[index] = { ...check, ...verdict };
  }
}

/**
 * Chooses how the judge is reached for a run.
 * @param plan - The run: its judge API or its judge harness, its cache, and the case's own `judgeModel`.
 * @param problems - Receives why a judge session does not prove it loaded nothing.
 * @returns The function that asks the judge, and what the scoring of a judge check needs to know of it.
 */
function judgeOf(plan: RunPlan, problems: string[]) {
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
 * @param run.task - The prompt that the agent was given.
 * @param run.outcome - What the judge reads of the run.
 * @param run.judgeable - False when the run is already invalid.
 * @param check - The check to score.
 * @param scored - Receives the judge's replies and cache hits, and whether the check was skipped.
 * @returns The check with its score; none when the run is invalid or a limit of the command is reached.
 */
async function judgedSlot(
  run: {
    plan: RunPlan;
    ask: ReturnType<typeof judgeOf>["ask"];
    via: Via;
    task: string;
    outcome: Outcome;
    judgeable: boolean;
  },
  check: JudgedCheck,
  scored: Scored,
): Promise<CheckResult> {
  if (!run.judgeable) {
    return {
      ...check,
      score: null,
      reason: "not judged, because the run is invalid",
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
function skippedFor(plan: RunPlan): string | null {
  const reached = plan.breached?.() ?? null;
  return reached === null ? null : `skipped: ${reached} reached`;
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
 * @param judgeable - False when the run is already invalid, which leaves the judged checks without a score.
 * @returns The check results in case order, every reply of the judge, and every request to the decision model.
 */
export async function scoreChecks(
  plan: RunPlan,
  outcome: Outcome,
  judgeable: boolean,
): Promise<{
  checks: CheckResult[];
  replies: Usage[];
  requests: Usage[];
  judgeProblem: string | null;
  /** How many judge votes the cache answered. */
  hits: number;
  /** True when a judged or decision check was skipped because a limit of the command was reached. */
  skippedGraders: boolean;
}> {
  const { prompt: task, checks: asked } = plan.caseDef;
  const problems: string[] = [];
  const { ask, via } = judgeOf(plan, problems);
  const scored: Scored = { replies: [], hits: 0, skipped: false };
  // One request carries every decision check of the case.
  const decisions = asked.filter(isDecision);
  const early = judgeable && decisions.length ? skippedFor(plan) : null;
  const decided =
    judgeable && plan.decision && decisions.length && early === null
      ? await decideAll(
          { model: plan.decision.model, task, outcome },
          decisions,
        )
      : null;
  const slots: (CheckResult | undefined)[] = asked.map(() => undefined);
  // Commands run last: they may change the files that the other checks read, and a login must not be readable by
  // them. The record keeps the case's order.
  for (const [index, check] of asked.entries()) {
    if (check.type === "command") continue;
    if (isDecision(check)) {
      const result = decided?.results.get(check);
      const left = result ?? (early === null ? NOT_DECIDED : skipped(early));
      scored.skipped ||= result === undefined && early !== null;
      slots[index] = { ...check, ...left };
    } else if (!isJudged(check)) {
      slots[index] = { ...check, ...(await ruled(check, outcome)) };
    } else {
      slots[index] = await judgedSlot(
        { plan, ask, via, task, outcome, judgeable },
        check,
        scored,
      );
    }
  }
  await runCommands(plan, { outcome, judgeable }, slots);
  const checks = slots.filter((slot) => slot !== undefined);
  return {
    checks,
    replies: scored.replies,
    requests: decided?.calls ?? [],
    judgeProblem: problems[0] ?? null,
    hits: scored.hits,
    skippedGraders: scored.skipped,
  };
}
