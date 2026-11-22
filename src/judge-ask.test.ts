import { expect, test } from "vitest";
import { askApi } from "./judge-api.js";
import type { JudgeApi } from "./judge-api.js";
import { API_KEY } from "./testing/judged.js";
import { failure, judgeServer, reply } from "./testing/judge-server.js";

const config = (url: string, more: Partial<JudgeApi> = {}): JudgeApi => ({
  kind: "anthropic",
  url,
  model: "m-1",
  keyVar: "ANTHROPIC_API_KEY",
  timeoutMs: 5000,
  fallbacks: true,
  env: { ANTHROPIC_API_KEY: API_KEY },
  ...more,
});

test("askApi reads the text blocks and ignores thinking", async () => {
  const { url } = await judgeServer([reply("hello")]);
  const answer = await askApi(config(url), "p", []);
  expect(answer).toMatchObject({ text: "hello", error: null });
  expect(answer.usage).toMatchObject({ tokens: { input: 100, output: 10 } });
});

test("askApi gives an error for a server error, a network error and a timeout", async () => {
  const { url } = await judgeServer([failure(503, "down")]);
  expect((await askApi(config(url), "p", [])).error).toMatch(/HTTP 503: down/);
  const dead = await askApi(config("http://127.0.0.1:1"), "p", []);
  expect(dead.error).toMatch(
    /request to http:\/\/127\.0\.0\.1:1\/v1\/messages failed/,
  );
  const slow = await judgeServer([{ hang: true }]);
  const late = await askApi(config(slow.url, { timeoutMs: 50 }), "p", []);
  expect(late.error).toMatch(/failed:.*timed out|failed:.*aborted/i);
});

test("askApi says so when the key is not set, the reply is no JSON, or the body has no text", async () => {
  const { url } = await judgeServer([{ body: "not json" }]);
  const none = await askApi(config(url, { env: {} }), "p", []);
  expect(none.error).toMatch(/judge API key is not set: set ANTHROPIC_API_KEY/);
  expect((await askApi(config(url), "p", [])).error).toMatch(/not JSON/);
  const empty = await judgeServer([{ body: "{}" }]);
  expect(await askApi(config(empty.url), "p", [])).toMatchObject({
    text: "",
    error: "the judge reply has no text",
  });
  const odd = await judgeServer([{ status: 500, body: "<html>" }]);
  expect((await askApi(config(odd.url), "p", [])).error).toMatch(
    /HTTP 500: <html>/,
  );
});
