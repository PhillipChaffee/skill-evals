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
  [
    { answers: { q1: HALF, q2: choice({ good: 0.499999, bad: 0.499999 }) } },
    /the probabilities of good, bad add up to 0\.999998, not 1/,
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

const GRADED = {
  type: "decision",
  weight: 1,
  question: "How good?",
  options: { good: 1, fair: 0.5, bad: 0 },
} as const;

/**
 * Asks one yes or no question and one question with three options.
 * @param probabilities - What the API returns for the three options.
 * @returns The results of the two checks.
 */
async function graded(probabilities: Record<string, number>) {
  const answers = { q1: yesNo(0.3), q2: choice(probabilities) };
  const server = await decisionServer([{ answers }]);
  const { model } = connect({ model: MODEL, url: server.url, env });
  const checks = [QUESTIONS[0], GRADED];
  const { results } = await decide(model, {
    task: "t",
    answer: ANSWER,
    checks,
  });
  return results;
}

test("probabilities rounded to 6 decimals are usable when their sum is one step off 1", async () => {
  const [plain, low] = await graded({
    good: 0.333333,
    fair: 0.333333,
    bad: 0.333333,
  });
  expect(low?.score, "0.333333 + 0.333333 x 0.5").toBeCloseTo(0.4999995, 9);
  expect(low?.probabilities).toEqual({
    good: 0.333333,
    fair: 0.333333,
    bad: 0.333333,
  });
  expect(plain, "the yes or no question").toMatchObject({ score: 0.3 });

  const [, high] = await graded({
    good: 0.333334,
    fair: 0.333334,
    bad: 0.333333,
  });
  expect(high?.score, "0.333334 + 0.333334 x 0.5").toBeCloseTo(0.500001, 9);
});

test("a score stays at 1 when the rounded probabilities are worth more", async () => {
  const [, top] = await graded({ good: 1, fair: 0.000001, bad: 0 });
  expect(top?.score, "1 + 0.000001 x 0.5, held at 1").toBe(1);
});

test("three options that keep probability back are rejected", async () => {
  const [plain, short] = await graded({
    good: 0.3333,
    fair: 0.3333,
    bad: 0.3333,
  });
  expect(short?.score).toBeNull();
  expect(short?.reason).toMatch(
    /the probabilities of good, fair, bad add up to 0\.9999\d*, not 1/,
  );
  expect(plain?.score, "one unusable question fails the request").toBeNull();
});

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
