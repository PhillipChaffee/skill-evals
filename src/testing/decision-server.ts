import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

// What every scripted response in the documented shape reports as its input tokens.
const INPUT_TOKENS = 200;
const OK = 200;

/** What the stand-in API does with one request. */
export interface Scripted {
  /** The HTTP status; 200 when absent. */
  status?: number;
  /** The `answers` of a response in the documented shape, by question name. */
  answers?: Record<string, unknown>;
  /** The whole body, in place of the documented shape. */
  body?: string;
  /** Never answers, so the client's time limit ends the request. */
  hang?: boolean;
}

/** One request the stand-in API received. */
export interface Received {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: {
    model: string;
    state: string;
    questions: Record<
      string,
      { type: string; instructions: string; criteria?: Record<string, null> }
    >;
  };
}

/**
 * Builds a yes or no answer in the documented response shape.
 * @param noul - The probability of yes.
 * @returns The answer.
 */
export const yesNo = (noul: unknown): unknown => ({ type: "noul", noul });

/**
 * Builds a choice answer in the documented response shape.
 * @param probabilities - The probability of each option.
 * @returns The answer, with the first option as the selected one.
 */
export const choice = (probabilities: Record<string, unknown>): unknown => ({
  type: "choice",
  choice: Object.keys(probabilities)[0],
  confidence: 0.5,
  probabilities,
});

/**
 * Starts a local HTTP server that speaks the response shape of Baseten's System One API, as its reference documents
 * it, and stops it when the test ends.
 * @param script - What to answer, one entry for each request in order; the last entry repeats.
 * @returns The base URL of the server, and every request it received.
 */
export async function decisionServer(
  script: Scripted[],
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (text += chunk));
    request.on("end", () => {
      const body = JSON.parse(text) as Received["body"];
      const scripted = script[Math.min(received.length, script.length - 1)];
      received.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      if (scripted?.hang) return;
      response.writeHead(scripted?.status ?? OK, {
        "Content-Type": "application/json",
      });
      response.end(
        scripted?.body ??
          JSON.stringify({
            model: "backend-model",
            answers: scripted?.answers,
            usage: {
              input_tokens: INPUT_TOKENS,
              output_tokens: Object.keys(body.questions).length,
            },
          }),
      );
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
