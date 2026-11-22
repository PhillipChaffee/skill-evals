import type { Usage } from "./run-plan.js";
import { messageOf } from "./scope.js";

/** The judge's model on the API path when no `judgeModel` is set. */
export const DEFAULT_API_MODEL = "claude-opus-5-5";

const SHOWN_MESSAGE_LENGTH = 200;
const MAX_TOKENS = 16_000;
const ANTHROPIC_VERSION = "2023-06-01";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** A file the judge gets besides the prompt: an image, sent as a block before the text. */
export interface Attachment {
  /** The file's path in the workspace. */
  name: string;
  /** "image/png", "image/jpeg", "image/gif" or "image/webp". */
  mediaType: string;
  /** The file, in base64. */
  data: string;
  /** The hash of the file's bytes, which the cache key holds. */
  sha256: string;
}

/** How to reach the judge model when no harness session is started. */
export interface JudgeApi {
  /** The provider's API shape. One today; another can be added without changing the callers. */
  kind: "anthropic";
  /** The base URL; `/v1/messages` is added. */
  url: string;
  model: string;
  /** The variable the API key is read from. */
  keyVar: string;
  /** How long one request may take. */
  timeoutMs: number;
  /** Ask the server to fall back when the model refuses. Turn off for a proxy that rejects the header. */
  fallbacks: boolean;
  /** Where the key is read from: this process's environment. */
  env: Record<string, string | undefined>;
}

/** What the judge said, or why it said nothing. */
export interface ApiAnswer {
  /** The text blocks of the reply, joined; empty when there is an error. */
  text: string;
  usage: Usage;
  /** Why the answer is unusable: the key is not set, the request failed, the API refused or answered an error. */
  error: string | null;
}

/** The parts of the API's reply that are read. Nothing is trusted to be there. */
interface WireReply {
  content?: { type?: unknown; text?: unknown }[];
  stop_reason?: unknown;
  stop_details?: { category?: unknown };
  usage?: {
    input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    output_tokens?: unknown;
  };
  error?: { message?: unknown };
}

const count = (value: unknown): number =>
  typeof value === "number" ? value : 0;

/**
 * Finds the message of an error response.
 * @param raw - The body.
 * @returns The API's own message when the body has one, else the body, cut to 200 characters.
 */
function apiMessage(raw: string): string {
  let said = raw.trim();
  try {
    const message = (Object(JSON.parse(raw)) as WireReply).error?.message;
    if (typeof message === "string") said = message;
  } catch {
    // The body is not JSON: it is shown as it is.
  }
  return said.slice(0, SHOWN_MESSAGE_LENGTH);
}

/**
 * Writes the request body.
 * @param config - The judge API.
 * @param prompt - The text.
 * @param attachments - Images, put before the text.
 * @returns The JSON of one Messages API request. It sets no `thinking`, `temperature`, `top_p` or `top_k`: current
 *   models reject sampling parameters and keep thinking on by default.
 */
const bodyOf = (
  config: JudgeApi,
  prompt: string,
  attachments: Attachment[],
): string =>
  JSON.stringify({
    model: config.model,
    max_tokens: MAX_TOKENS,
    ...(config.fallbacks ? { fallbacks: "default" } : {}),
    messages: [
      {
        role: "user",
        content: [
          ...attachments.map(({ mediaType, data }) => ({
            type: "image",
            source: { type: "base64", media_type: mediaType, data },
          })),
          { type: "text", text: prompt },
        ],
      },
    ],
  });

/**
 * Reads a successful reply.
 * @param raw - The body of a 2xx response.
 * @returns The text, the tokens, and the error when the model refused.
 */
function readReply(
  raw: string,
): Omit<ApiAnswer, "usage"> & Pick<Usage, "tokens"> {
  let reply: WireReply;
  try {
    reply = Object(JSON.parse(raw)) as WireReply;
  } catch {
    return { text: "", error: "the reply is not JSON", tokens: null };
  }
  const usage = reply.usage ?? {};
  const tokens = {
    input:
      count(usage.input_tokens) +
      count(usage.cache_read_input_tokens) +
      count(usage.cache_creation_input_tokens),
    output: count(usage.output_tokens),
  };
  const category = reply.stop_details?.category;
  const error =
    reply.stop_reason === "refusal"
      ? `the model refused to answer${typeof category === "string" ? ` (${category})` : ""}`
      : null;
  const text = (Array.isArray(reply.content) ? reply.content : [])
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("");
  return { text: error ? "" : text, error, tokens };
}

/**
 * Asks the judge model one question, with no harness process.
 * @param config - The API, its key variable and its limits.
 * @param prompt - The text.
 * @param attachments - Images that go before the text.
 * @returns The text and what the call cost: the input tokens are the input, cache reads and cache writes added up, and
 *   the cost is null because the package holds no price table. A failed request, an API error and a refusal come back
 *   as `error`, never as a rejection: the judge tries once more.
 */
export async function askApi(
  config: JudgeApi,
  prompt: string,
  attachments: Attachment[],
): Promise<ApiAnswer> {
  const started = Date.now();
  const done = (
    text: string,
    error: string | null,
    tokens: Usage["tokens"] = null,
  ): ApiAnswer => ({
    text,
    error,
    usage: { durationMs: Date.now() - started, tokens, costUsd: null },
  });
  const key = config.env[config.keyVar];
  if (!key) {
    return done("", `the judge API key is not set: set ${config.keyVar}`);
  }
  const endpoint = `${config.url.replace(/\/+$/, "")}/v1/messages`;
  let response: Response;
  let raw: string;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        ...(config.fallbacks ? { "anthropic-beta": FALLBACK_BETA } : {}),
      },
      body: bodyOf(config, prompt, attachments),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    raw = await response.text();
  } catch (error) {
    return done("", `the request to ${endpoint} failed: ${messageOf(error)}`);
  }
  if (!response.ok) {
    return done("", `HTTP ${String(response.status)}: ${apiMessage(raw)}`);
  }
  const { text, error, tokens } = readReply(raw);
  return done(text, error, tokens);
}

/**
 * Builds the function that asks the judge over the API.
 * @param config - The judge API.
 * @returns A function with the shape of a judge session's reply: the final text, the error, and what the call cost.
 */
export const apiAsker =
  (config: JudgeApi) => async (prompt: string, attachments: Attachment[]) => {
    const { text, error, usage } = await askApi(config, prompt, attachments);
    return { finalText: text, error, ...usage };
  };
