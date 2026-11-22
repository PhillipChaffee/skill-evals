import type { Case } from "./cases.js";
import { isJudged } from "./checks/index.js";
import { DEFAULT_API_MODEL } from "./judge-api.js";

/**
 * Picks the judge's model, and warns, once, when a judge check would run on the model under test.
 * @param options - The model under test and the judge's model, each undefined when not set.
 * @param options.model - The model under test.
 * @param options.judgeModel - The model the judge is asked to use.
 * @param options.judgeApi - Set when the judge asks an API, whose default model is not the model under test.
 * @param cases - The cases of the command; a case's own `judgeModel` wins over the option.
 * @returns The judge's model: `judgeModel`, else the API's default model when `judgeApi` is set, else `model`. Both
 *   unset count as the same model.
 */
export function judgeModelOf(
  options: {
    model?: string | undefined;
    judgeModel?: string | undefined;
    judgeApi?: string | undefined;
  },
  cases: Case[],
): string | undefined {
  const judgeModel =
    options.judgeModel ??
    (options.judgeApi === undefined ? options.model : DEFAULT_API_MODEL);
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
