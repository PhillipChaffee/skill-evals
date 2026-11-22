import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

const OK = 200;

/** What the stand-in API does with one request. */
export interface Canned {
  /** The HTTP status; 200 when absent. */
  status?: number;
  /** The text block of a reply in the Messages API shape. */
  text?: string;
  /** Why the reply stopped; "end_turn" when absent. */
  stopReason?: string;
  /** For a refusal, its category. */
  category?: string;
  /** The usage block. Default: 100 input tokens and 10 output tokens. */
  usage?: Record<string, number>;
  /** The whole body, in place of the Messages API shape. */
  body?: string;
  /** Never answers, so the client's time limit ends the request. */
  hang?: boolean;
}

/** One request the stand-in API received. */
export interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: {
    model: string;
    max_tokens: number;
    messages: {
      role: string;
      content: { type: string; text?: string; source?: unknown }[];
    }[];
    [key: string]: unknown;
  };
}

/**
 * Builds a canned reply that holds a thinking block and then the text, as a current model sends it.
 * @param text - What the model says.
 * @param usage - The usage block, when the test cares.
 * @returns The canned response.
 */
export const reply = (
  text: string,
  usage?: Record<string, number>,
): Canned => ({
  text,
  ...(usage ? { usage } : {}),
});

/**
 * Builds a canned refusal.
 * @param category - The `stop_details.category`; none when absent.
 * @returns The canned response.
 */
export const refusal = (category?: string): Canned => ({
  stopReason: "refusal",
  ...(category === undefined ? {} : { category }),
});

/**
 * Builds a canned error response.
 * @param status - The HTTP status.
 * @param message - The API's error message.
 * @returns The canned response.
 */
export const failure = (status: number, message: string): Canned => ({
  status,
  body: JSON.stringify({
    type: "error",
    error: { type: "api_error", message },
  }),
});

/**
 * Writes a canned response in the shape of the Messages API.
 * @param canned - What to answer.
 * @returns The body.
 */
function messageOf(canned: Canned): string {
  return JSON.stringify({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [
      { type: "thinking", thinking: "Let me weigh it.", signature: "x" },
      ...(canned.text === undefined
        ? []
        : [{ type: "text", text: canned.text }]),
    ],
    stop_reason: canned.stopReason ?? "end_turn",
    ...(canned.category === undefined
      ? {}
      : { stop_details: { type: "refusal", category: canned.category } }),
    usage: canned.usage ?? { input_tokens: 100, output_tokens: 10 },
  });
}

/**
 * Starts a local HTTP server that speaks the Messages API, and stops it when the test ends. No test reaches the
 * internet: it points `judgeUrl` here.
 * @param script - What to answer, one entry for each request in order; the last entry repeats.
 * @returns The base URL of the server, and every request it received.
 */
export async function judgeServer(
  script: Canned[],
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (text += chunk));
    request.on("end", () => {
      const canned = script[Math.min(received.length, script.length - 1)];
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(text) as Received["body"],
      });
      if (canned?.hang) return;
      response.writeHead(canned?.status ?? OK, {
        "Content-Type": "application/json",
      });
      response.end(canned?.body ?? messageOf(canned ?? {}));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, received };
}
