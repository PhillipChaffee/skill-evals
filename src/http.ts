import { messageOf } from "./scope.js";

const SHOWN_LENGTH = 200;
const REDACTED = "[redacted]";

/**
 * Hides a secret in text that came from a provider, which may echo what it was sent.
 * @param text - Any text of a response or an error.
 * @param secret - The API key; empty hides nothing.
 * @returns The text with every occurrence of the secret replaced by `[redacted]`.
 */
const redact = (text: string, secret: string): string =>
  secret === "" ? text : text.split(secret).join(REDACTED);

/**
 * Shortens provider text for a reason that is written to `results.json`.
 * @param text - A message or a body.
 * @param secret - The API key, hidden before the text is cut, so that no half of it is left at the cut.
 * @returns The trimmed text, redacted and cut to 200 characters.
 */
export const shown = (text: string, secret: string): string =>
  redact(text.trim(), secret).slice(0, SHOWN_LENGTH);

/**
 * Joins a base URL and a path.
 * @param base - The base URL, with or without trailing slashes.
 * @param path - The path, which starts with a slash.
 * @returns The endpoint.
 */
export const joinUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, "")}${path}`;

/** What one POST needs. */
interface Post {
  headers: Record<string, string>;
  body: string;
  /** The request ends after this long. */
  timeoutMs: number;
  /** The API key, which an error message never carries. */
  secret: string;
}

/**
 * Sends one JSON POST with a time limit.
 * @param endpoint - The URL.
 * @param request - Headers, body, limit and the secret to hide.
 * @returns Whether the status is 2xx, the status, and the body text.
 * @throws {Error} When the request fails or times out; the message names the endpoint and hides the secret. The error
 *   has no cause: the original would hold the text that echoed the secret.
 */
export async function post(
  endpoint: string,
  request: Post,
): Promise<{ ok: boolean; status: number; text: string }> {
  const sent = await fetch(endpoint, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(request.timeoutMs),
  })
    .then(async (response) => ({
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    }))
    .catch((error: unknown) => messageOf(error));
  if (typeof sent === "string") {
    throw new Error(
      redact(`the request to ${endpoint} failed: ${sent}`, request.secret),
    );
  }
  return sent;
}
