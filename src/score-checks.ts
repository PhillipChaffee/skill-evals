import type { Outcome } from "./checks/index.js";
import { checkScore, isDecision, isJudged } from "./checks/index.js";
import { decide } from "./decision.js";
import { judge } from "./judge.js";
import type { CheckResult, RunPlan, Usage } from "./run.js";
import { judgeAsker } from "./startup.js";

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
 * Names what no harness process of a run may get.
 * @param plan - The run.
 * @returns The decision model's key, when there is a decision model.
 */
export const withheld = (plan: RunPlan): string[] =>
  plan.decision ? [plan.decision.secret] : [];

/**
 * Scores every check of a case for one run.
 * @param plan - The run; its judge scores the judged checks, with nothing loaded and a prompt that carries nothing
 *   about the subject.
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
}> {
  const { prompt: task, checks: asked } = plan.caseDef;
  const withhold = withheld(plan);
  const problems: string[] = [];
  const ask = judgeAsker(
    { ...plan.judge, model: plan.caseDef.judgeModel ?? plan.judge.model },
    { isolated: plan.isolated ?? false, withhold, pass: plan.pass },
    problems,
  );
  // One request carries every decision check of the case.
  const decisions = asked.filter(isDecision);
  const decided =
    judgeable && plan.decision && decisions.length
      ? await decide(plan.decision.model, {
          task,
          answer: outcome.finalText,
          checks: decisions,
        })
      : null;
  const checks: CheckResult[] = [];
  const replies: Usage[] = [];
  for (const check of asked) {
    if (isDecision(check)) {
      const result = decided?.results[decisions.indexOf(check)];
      checks.push({ ...check, ...(result ?? NOT_DECIDED) });
    } else if (!isJudged(check)) {
      const verdict =
        check.type === "command" && !judgeable
          ? NOT_RUN
          : await checkScore(check, outcome);
      checks.push({ ...check, ...verdict });
    } else if (!judgeable) {
      const reason = "not judged, because the run is invalid";
      checks.push({ ...check, score: null, reason });
    } else {
      const verdict = await judge(ask, {
        task,
        answer: outcome.finalText,
        rubric: check.rubric,
      });
      replies.push(...verdict.replies);
      checks.push({ ...check, score: verdict.score, reason: verdict.reason });
    }
  }
  return {
    checks,
    replies,
    requests: decided?.calls ?? [],
    judgeProblem: problems[0] ?? null,
  };
}
