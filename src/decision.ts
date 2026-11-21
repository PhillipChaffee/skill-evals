import type { DecisionCheck } from "./checks.js";
import type { Tokens } from "./harnesses/shared.js";
import { messageOf } from "./scope.js";

const ATTEMPTS = 2;
// Float error in a sum of probabilities that add up to 1.
const SUM_TOLERANCE = 1e-6;

/** One question to a decision model: a yes or no question, or a choice among named options. */
export type DecisionQuestion =
  | { kind: "yes_no"; question: string }
  | { kind: "choice"; question: string; options: string[] };

/** What to decide: the material every question is about, and the questions by name. */
export interface DecisionRequest {
  state: string;
  questions: Record<string, DecisionQuestion>;
}

/** What a decision model returned for one request. A number the provider does not report is null. */
export interface DecisionReply {
  /**
   * Question name, then answer, then probability. A yes or no question has the answers "yes" and "no". The values
   * come from outside this program, so they are not trusted to be numbers until `expectedValue` has read them.
   */
  probabilities: Record<string, Record<string, unknown> | undefined>;
  tokens: Tokens | null;
  costUsd: number | null;
}

/** A model that generates no text: it returns a probability for each allowed answer of each question. */
export interface DecisionModel {
  /** Rejects when the request fails or the provider's reply cannot be read. */
  decide: (request: DecisionRequest) => Promise<DecisionReply>;
}

/** A decision model that is ready to call, and the environment variable that holds its key, which no harness may see. */
export interface DecisionService {
  model: DecisionModel;
  secret: string;
}

/** What one request to the decision model cost. */
interface DecisionCall {
  durationMs: number;
  tokens: Tokens | null;
  costUsd: number | null;
}

/** What a decision check gets from one run. */
interface DecisionResult {
  /** Null when the model gave no usable probabilities. */
  score: number | null;
  /** The probability of each allowed answer, as the model returned it. */
  probabilities?: Record<string, number>;
  /** Why there is no score. */
  reason?: string;
}

/**
 * Says what each answer of a decision check is worth.
 * @param check - A decision check.
 * @returns Its `options`; for a yes or no question, 1 for the expected answer and 0 for the other one.
 */
const answerValues = (check: DecisionCheck): Record<string, number> =>
  check.options ?? {
    yes: Number(check.expect === "yes"),
    no: Number(check.expect === "no"),
  };

/**
 * Writes what the decision model reads.
 * @param task - The prompt the agent got.
 * @param answer - The agent's final message.
 * @returns The two parts, delimited, and nothing that says where the answer came from.
 */
const decisionState = (task: string, answer: string): string =>
  ["<task>", task, "</task>", "", "<answer>", answer, "</answer>"].join("\n");

/**
 * Scores one decision check from the probabilities of its answers.
 * @param values - What each allowed answer is worth.
 * @param returned - What the model returned for the question.
 * @returns The expected value, which is the sum of probability times value, and the probabilities it was computed from.
 * @throws {Error} When an allowed answer has no probability, a probability is not a number from 0 to 1, or the
 *   probabilities of the allowed answers do not add up to 1. Nothing is filled in or scaled.
 */
function expectedValue(
  values: Record<string, number>,
  returned: Record<string, unknown> | undefined,
): { score: number; probabilities: Record<string, number> } {
  if (!returned) throw new Error("it returned no probabilities for a question");
  const probabilities: Record<string, number> = {};
  let sum = 0;
  let score = 0;
  for (const [answer, value] of Object.entries(values)) {
    const probability = Object.hasOwn(returned, answer)
      ? returned[answer]
      : undefined;
    if (
      typeof probability !== "number" ||
      !(probability >= 0 && probability <= 1)
    ) {
      throw new Error(
        `the probability of "${answer}" must be a number from 0 to 1, got ${JSON.stringify(probability)}`,
      );
    }
    probabilities[answer] = probability;
    sum += probability;
    score += probability * value;
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) {
    throw new Error(
      `the probabilities of ${Object.keys(values).join(", ")} add up to ${String(sum)}, not 1`,
    );
  }
  // The sum may pass 1 by float error only, which the tolerance above bounds.
  return { score: Math.min(score, 1), probabilities };
}

/**
 * Sends one request and times it.
 * @param model - The decision model.
 * @param request - The state and the questions.
 * @returns The reply, or why there is none, and what the request cost. A failed request reports no tokens.
 */
async function attempt(
  model: DecisionModel,
  request: DecisionRequest,
): Promise<{ reply: DecisionReply | string; call: DecisionCall }> {
  const started = Date.now();
  try {
    const reply = await model.decide(request);
    const { tokens, costUsd } = reply;
    return {
      reply,
      call: { durationMs: Date.now() - started, tokens, costUsd },
    };
  } catch (error) {
    const call = {
      durationMs: Date.now() - started,
      tokens: null,
      costUsd: null,
    };
    return { reply: messageOf(error), call };
  }
}

/**
 * Scores every decision check of one run with one request, sent once more when the first answer is unusable.
 * @param model - The decision model.
 * @param run - What to decide about.
 * @param run.task - The prompt the agent got.
 * @param run.answer - The agent's final message.
 * @param run.checks - The decision checks of the case; each becomes one question of the request.
 * @returns One result for each check, in order, and what every request cost. After two unusable answers no check
 *   has a score: one question without usable probabilities fails the whole request.
 */
export async function decide(
  model: DecisionModel,
  run: { task: string; answer: string; checks: DecisionCheck[] },
): Promise<{ results: DecisionResult[]; calls: DecisionCall[] }> {
  const names = run.checks.map((_, index) => `q${String(index + 1)}`);
  const request = {
    state: decisionState(run.task, run.answer),
    questions: Object.fromEntries(
      run.checks.map(
        ({ question, options }, index): [string, DecisionQuestion] => [
          String(names[index]),
          options
            ? { kind: "choice", question, options: Object.keys(options) }
            : { kind: "yes_no", question },
        ],
      ),
    ),
  };
  const calls: DecisionCall[] = [];
  let failure = "";
  while (calls.length < ATTEMPTS) {
    const { reply, call } = await attempt(model, request);
    calls.push(call);
    try {
      if (typeof reply === "string") throw new Error(reply);
      const results = run.checks.map((check, index) =>
        expectedValue(
          answerValues(check),
          reply.probabilities[String(names[index])],
        ),
      );
      return { results, calls };
    } catch (error) {
      failure = messageOf(error);
    }
  }
  const reason = `the decision model gave no usable answer: ${failure}`;
  return { results: run.checks.map(() => ({ score: null, reason })), calls };
}
