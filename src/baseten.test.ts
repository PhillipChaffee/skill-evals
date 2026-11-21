import { expect, test } from "vitest";
import { connect } from "./baseten.js";
import { decide } from "./decision.js";
import type { Scripted } from "./testing/decision-server.js";
import { choice, decisionServer, yesNo } from "./testing/decision-server.js";

const ANSWER = "It is fixed now.";
const MODEL = "decider-one";
const KEY = "skill-evals-decision-key";
const env = { BASETEN_API_KEY: KEY };
const NO_PROBABILITIES = /no probabilities for a question/;

const QUESTIONS = [
  { type: "decision", weight: 1, question: "Is it plain?", expect: "yes" },
  {
    type: "decision",
    weight: 1,
    question: "Good?",
    options: { good: 1, bad: 0 },
  },
] as const;
const HALF = yesNo(0.5);
const UNUSABLE: [Scripted, RegExp][] = [
  [
    {
      status: 422,
      body: '{"error": "Question type must be choice, noul or score", "error_type": "Validation"}',
    },
    /answered HTTP 422: \{"error": "Question type must be/,
  ],
  [{ body: "<html>bad gateway</html>" }, /not valid JSON/],
  [{ body: "null" }, NO_PROBABILITIES],
  [{ answers: {} }, NO_PROBABILITIES],
  [
    { answers: { q1: yesNo("high"), q2: choice({ good: 1, bad: 0 }) } },
    NO_PROBABILITIES,
  ],
  [
    { answers: { q1: HALF, q2: { type: "choice", probabilities: "none" } } },
    NO_PROBABILITIES,
  ],
  [
    { answers: { q1: HALF, q2: { type: "choice", probabilities: null } } },
    NO_PROBABILITIES,
  ],
  [
    { answers: { q1: HALF, q2: choice({ good: 1 }) } },
    /the probability of "bad" must be a number from 0 to 1, got undefined/,
  ],
  [
    { answers: { q1: HALF, q2: choice({ good: 1.1, bad: -0.1 }) } },
    /the probability of "good" must be a number from 0 to 1, got 1\.1/,
  ],
  [
    { answers: { q1: HALF, q2: choice({ good: 0.9, bad: -0.1 }) } },
    /the probability of "bad" must be a number from 0 to 1, got -0\.1/,
  ],
  [
    { answers: { q1: HALF, q2: choice({ good: "0.5", bad: 0.5 }) } },
    /the probability of "good" must be a number from 0 to 1, got "0\.5"/,
  ],
  [
    { answers: { q1: HALF, q2: choice({ good: 0.5, bad: 0.2 }) } },
    /the probabilities of good, bad add up to 0\.7, not 1/,
  ],
  [{ hang: true }, /the request to http:\S+\/v1\/systemone failed: .*timeout/i],
];

test.each(UNUSABLE)(
  "the reply %j is unusable, is not patched, and is asked for twice",
  async (scripted, reason) => {
    const server = await decisionServer([scripted]);
    const { model } = connect({
      model: MODEL,
      url: server.url,
      env,
      timeoutMs: 100,
    });
    const run = { task: "say it", answer: ANSWER, checks: [...QUESTIONS] };
    const { results, calls } = await decide(model, run);
    expect(server.received).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(results.map((result) => result.score)).toEqual([null, null]);
    expect(results[0]?.reason).toMatch(reason);
    expect(results[0]?.reason).not.toContain(KEY);
  },
);

test("a reply may hold more than was asked for, and need not report usage", async () => {
  const body = JSON.stringify({
    answers: {
      q1: HALF,
      q2: choice({ good: 0.25, bad: 0.75, unknown: 0 }),
      q3: yesNo(1),
    },
  });
  const server = await decisionServer([{ body }]);
  // A base URL may end with a slash, and the endpoint is still reached.
  const { model, secret } = connect({
    model: MODEL,
    url: `${server.url}/`,
    env,
  });
  const run = { task: "say it", answer: ANSWER, checks: [...QUESTIONS] };
  const { results, calls } = await decide(model, run);
  expect(results).toEqual([
    { score: 0.5, probabilities: { yes: 0.5, no: 0.5 } },
    { score: 0.25, probabilities: { good: 0.25, bad: 0.75 } },
  ]);
  expect(calls).toMatchObject([{ tokens: null, costUsd: null }]);
  expect(server.received[0]?.url).toBe("/v1/systemone");
  expect(secret).toBe("BASETEN_API_KEY");
});

test("a request that cannot connect is a failed attempt", async () => {
  const { model } = connect({
    model: MODEL,
    url: "http://127.0.0.1:9",
    env,
  });
  const run = { task: "say it", answer: ANSWER, checks: [...QUESTIONS] };
  const { results, calls } = await decide(model, run);
  expect(calls).toHaveLength(2);
  expect(results[0]?.reason).toMatch(
    /the request to http:\/\/127\.0\.0\.1:9\/v1\/systemone failed/,
  );
});
