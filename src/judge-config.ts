import type { Case } from "./cases.js";
import type { Located } from "./harnesses/index.js";
import { selectHarnesses } from "./harnesses/index.js";
import { judgeModelOf } from "./judge-warning.js";
import { isJudged } from "./checks/index.js";
import type { JudgeApi } from "./judge-api.js";
import type { Config } from "./project.js";
import { MS_PER_SECOND, requireSeconds } from "./seconds.js";
import { UsageError } from "./scope.js";

const DEFAULT_URL = "https://api.anthropic.com";
const DEFAULT_KEY_VAR = "ANTHROPIC_API_KEY";
const DEFAULT_TIMEOUT_SECONDS = 120;

/**
 * Sets up the judge API when the command uses it, before any harness starts.
 * @param cases - The cases of the suite.
 * @param options - The options after the config file was applied.
 * @param model - The judge's model, which `judgeModel` or the API's default gave.
 * @returns The API, or null when `judgeApi` is not set or no case has a judge check.
 * @throws {UsageError} When `judgeApi` is not "anthropic", `judgeTimeout` is not a positive integer of seconds, or a
 *   case has a judge check and the key variable is not set.
 */
function judgeApiFor(
  cases: Case[],
  options: Config & { judgeHarness?: string | undefined },
  model: string,
): JudgeApi | null {
  const {
    judgeApi: kind,
    judgeTimeout: seconds = DEFAULT_TIMEOUT_SECONDS,
    judgeKeyVar: keyVar = DEFAULT_KEY_VAR,
  } = options;
  if (kind === undefined) return null;
  if (kind !== "anthropic") {
    throw new UsageError(`judgeApi must be "anthropic", got "${kind}"`);
  }
  requireSeconds("judgeTimeout", seconds);
  if (options.judgeHarness) {
    console.error(
      "skill-evals: warning: --judge-harness is ignored, because judgeApi is set",
    );
  }
  if (!cases.some((one) => one.checks.some(isJudged))) return null;
  if (!process.env[keyVar]) {
    throw new UsageError(
      `a case has a judge check, but the judge API key is not set: set ${keyVar}`,
    );
  }
  const url = options.judgeUrl ?? DEFAULT_URL;
  if (!URL.canParse(url)) {
    throw new UsageError(`the judge URL is not a URL: ${url}`);
  }
  return {
    kind,
    url,
    model,
    keyVar,
    timeoutMs: seconds * MS_PER_SECOND,
    fallbacks: options.judgeFallbacks ?? true,
    env: process.env,
  };
}

/**
 * Picks the harness that judges.
 * @param options - The options after the config file was applied.
 * @param options.judgeHarness - The harness the user named, if any.
 * @param options.judgeApi - Set when the judge asks an API.
 * @returns The harness `judgeHarness` names; none when it is not set, and none under `judgeApi`, which ignores it.
 * @throws {UsageError} When the name is not a harness.
 */
export function judgeHarnessOf(options: {
  judgeHarness?: string | undefined;
  judgeApi?: string | undefined;
}): Located | undefined {
  return options.judgeHarness && options.judgeApi === undefined
    ? selectHarnesses(options.judgeHarness).chosen[0]
    : undefined;
}

/**
 * Settles the judge's model and API, once the cases are known.
 * @param cases - The cases of the suite.
 * @param options - The options after the config file was applied.
 * @returns The judge API (null for a harness session) and the judge's model.
 */
export function judgeSetup(
  cases: Case[],
  options: Config & {
    judgeHarness?: string | undefined;
    model?: string | undefined;
  },
): { judgeApi: JudgeApi | null; judgeModel: string | undefined } {
  const judgeModel = judgeModelOf(options, cases);
  return {
    judgeApi: judgeApiFor(cases, options, judgeModel ?? ""),
    judgeModel,
  };
}
