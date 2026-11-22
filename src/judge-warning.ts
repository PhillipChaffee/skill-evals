import type { Case } from "./cases.js";
import { isJudged } from "./checks/index.js";

/**
 * Picks the judge's model, and warns, once, when a judge check would run on the model under test.
 * @param options - The model under test and the judge's model, each undefined when not set.
 * @param options.model - The model under test.
 * @param options.judgeModel - The model the judge is asked to use.
 * @param cases - The cases of the command; a case's own `judgeModel` wins over the option.
 * @returns The judge's model: `judgeModel`, else `model`. Both unset count as the same model.
 */
export function judgeModelOf(
  options: { model?: string | undefined; judgeModel?: string | undefined },
  cases: Case[],
): string | undefined {
  const judgeModel = options.judgeModel ?? options.model;
  const same = cases.some(
    (one) =>
      one.checks.some(isJudged) &&
      (one.judgeModel ?? judgeModel) === options.model,
  );
  if (same) {
    console.error(
      "skill-evals: warning: the judge is the model under test; set --judge-model or judgeModel",
    );
  }
  return judgeModel;
}
