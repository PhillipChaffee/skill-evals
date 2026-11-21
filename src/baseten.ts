// The one module that knows Baseten's System One API: its URL, its key variable, and its field names.
// Written from https://docs.baseten.co/reference/inference-api/system-one and
// https://docs.baseten.co/inference/model-apis/decision-models.
import type {
  DecisionQuestion,
  DecisionReply,
  DecisionRequest,
  DecisionService,
} from "./decision.js";
import { UsageError, messageOf } from "./scope.js";

const DEFAULT_URL = "https://inference.baseten.co";
const ENDPOINT = "/v1/systemone";
const KEY_VARIABLE = "BASETEN_API_KEY";
const DEFAULT_TIMEOUT_MS = 60_000;
const SHOWN_BODY_LENGTH = 200;

/** How to reach the decision model. */
interface Connection {
  /** The model slug, sent unchanged. */
  model: string;
  /** The base URL of another endpoint that speaks the same API, such as a deployment of your own. */
  url?: string | undefined;
  /** Where the API key is read from. */
  env: Record<string, string | undefined>;
  /** How long one request may take. */
  timeoutMs?: number;
}

/** A question as the API takes it. A null description makes the API use the option's name alone. */
type WireQuestion =
  | { type: "noul"; instructions: string }
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, null>;
    };

/** The parts of the API's response that are read. Nothing is trusted to be there. */
interface WireResponse {
  answers?: Partial<
    Record<string, { noul?: unknown; probabilities?: unknown }>
  >;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

const toWire = (asked: DecisionQuestion): WireQuestion =>
  asked.kind === "yes_no"
    ? { type: "noul", instructions: asked.question }
    : {
        type: "choice",
        instructions: asked.question,
        criteria: Object.fromEntries(
          asked.options.map((option) => [option, null]),
        ),
      };

/**
 * Reads the API's response.
 * @param text - The body of a 2xx response.
 * @param questions - The questions that were asked.
 * @returns The probabilities of each question that the response answers in the form of its type: `noul`, the
 *   probability of yes, becomes "yes" and "no", and a choice keeps its `probabilities`. The API returns no cost.
 * @throws {SyntaxError} When the body is not JSON.
 */
function readResponse(
  text: string,
  questions: DecisionRequest["questions"],
): DecisionReply {
  const response = Object(JSON.parse(text)) as WireResponse;
  const answers = Object(response.answers) as NonNullable<
    WireResponse["answers"]
  >;
  const probabilities: DecisionReply["probabilities"] = {};
  for (const [name, asked] of Object.entries(questions)) {
    const answer = Object(answers[name]) as {
      noul?: unknown;
      probabilities?: unknown;
    };
    if (asked.kind === "choice") {
      const given = answer.probabilities;
      if (given !== null && typeof given === "object") {
        probabilities[name] = given as Record<string, unknown>;
      }
    } else if (typeof answer.noul === "number") {
      probabilities[name] = { yes: answer.noul, no: 1 - answer.noul };
    }
  }
  const { input_tokens: input, output_tokens: output } = Object(
    response.usage,
  ) as NonNullable<WireResponse["usage"]>;
  const tokens =
    typeof input === "number" && typeof output === "number"
      ? { input, output }
      : null;
  return { probabilities, tokens, costUsd: null };
}

/**
 * Connects to a decision model behind Baseten's System One API.
 * @param connection - The model, the endpoint, and where the key is.
 * @returns The model, which sends each request as one POST, and the name of the key's variable.
 * @throws {UsageError} When the key's variable is not set, or the URL is not one.
 */
export function connect(connection: Connection): DecisionService {
  const { model, url = DEFAULT_URL, env } = connection;
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = connection;
  const key = env[KEY_VARIABLE];
  if (!key) {
    throw new UsageError(
      `a case has a decision check, but the decision model's API key is not set: set ${KEY_VARIABLE} in the environment`,
    );
  }
  if (!URL.canParse(url)) {
    throw new UsageError(`the decision URL is not a URL: ${url}`);
  }
  const endpoint = `${url.endsWith("/") ? url.slice(0, -1) : url}${ENDPOINT}`;
  const decide = async (request: DecisionRequest): Promise<DecisionReply> => {
    const questions = Object.fromEntries(
      Object.entries(request.questions).map(([name, asked]) => [
        name,
        toWire(asked),
      ]),
    );
    let response;
    let text;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, state: request.state, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      throw new Error(
        `the request to ${endpoint} failed: ${messageOf(error)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new Error(
        `${endpoint} answered HTTP ${String(response.status)}: ${text.trim().slice(0, SHOWN_BODY_LENGTH)}`,
      );
    }
    return readResponse(text, request.questions);
  };
  return { model: { decide }, secret: KEY_VARIABLE };
}
