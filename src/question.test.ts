import { expect, test } from "vitest";
import { checkScore } from "./checks/index.js";
import type { Check, RuledCheck } from "./checks/index.js";
import { HARNESSES } from "./harnesses/index.js";
import {
  endsAwaiting,
  questionText,
  questionsIn,
  withQuestions,
} from "./question.js";
import { lines, parseText } from "./testing/streams.js";
import { call, played, result } from "./testing/transcript.js";
import { checkRate } from "./report/metrics.js";
import { unionLoaded } from "./turn-merge.js";
import type { RunRecord } from "./run.js";

const CLAUDE = "claude-code";

const ask = (question: string, id: string) =>
  call("AskUserQuestion", { questions: [{ question }] }, id);
const ran = (id: string) => call("Bash", { command: `run ${id}` }, id);
const rule = (fields: Record<string, unknown>): RuledCheck => ({
  type: "asked_user",
  weight: 1,
  ...fields,
});

test("Claude Code's AskUserQuestion is a question call, and the result's denial says it stopped for input", () => {
  const init = { type: "system", subtype: "init", session_id: "s" };
  const assistant = {
    type: "assistant",
    message: {
      id: "m",
      content: [
        {
          type: "tool_use",
          id: "q1",
          name: "AskUserQuestion",
          input: { questions: [{ question: "Which database?" }] },
        },
      ],
    },
  };
  const done = { type: "result", subtype: "success", is_error: false };
  const denied = {
    ...done,
    permission_denials: [{ tool_name: "AskUserQuestion", tool_use_id: "q1" }],
  };
  const parsed = parseText(CLAUDE, lines(init, assistant, denied));
  expect(parsed.toolCalls.map(({ kind }) => kind)).toEqual(["question"]);
  expect(parsed.askedUser).toBe(true);
  // A denial of another tool, or none, is not asking; with no result nothing is reported.
  const stale = {
    ...done,
    permission_denials: [{ tool_name: "AskUserQuestion", tool_use_id: "q0" }],
  };
  expect(parseText(CLAUDE, lines(init, assistant, stale)).askedUser).toBe(
    false,
  );
  const other = { ...done, permission_denials: [{ tool_name: "Bash" }] };
  expect(parseText(CLAUDE, lines(init, assistant, other)).askedUser).toBe(
    false,
  );
  expect(parseText(CLAUDE, lines(init, assistant, done)).askedUser).toBe(false);
  expect(parseText(CLAUDE, lines(init, assistant)).askedUser).toBeNull();
});

test("only Claude Code declares askUser, and no other adapter maps a question tool", () => {
  const declared = HARNESSES.filter(({ capabilities }) =>
    capabilities.has("askUser"),
  ).map(({ id }) => id);
  expect(declared).toEqual([CLAUDE]);
});

test("the question text is what the adapter read, else the input as JSON", () => {
  const claude = HARNESSES.find(({ id }) => id === CLAUDE);
  const read = (input: unknown) => claude?.questionText?.(input) ?? null;
  expect(read({ questions: [{ question: "A?" }, { question: "B?" }, 3] })).toBe(
    "A?\nB?",
  );
  expect(read({ prompt: "Which?" })).toBeNull();
  expect(read({ questions: [] })).toBeNull();
  expect(questionText({ input: { prompt: "Which?" }, question: "A?" })).toBe(
    "A?",
  );
  expect(questionText({ input: { prompt: "Which?" } })).toBe(
    '{"prompt":"Which?"}',
  );
  // A parse through an adapter with no question reader leaves the stream as it is.
  const parsed = parseText(CLAUDE, "");
  expect(withQuestions({}, parsed)).toBe(parsed);
});

test("asked_user counts question calls with min, max and pattern", async () => {
  const two = played(
    ask("Which database?", "a"),
    ran("b"),
    ask("Which port?", "c"),
  );
  const score = async (fields: Record<string, unknown>, out = two) =>
    (await checkScore(rule(fields), out)).score;
  expect(await score({})).toBe(1);
  expect(await score({ min: 2 })).toBe(1);
  expect(await score({ min: 3 })).toBe(0);
  expect(await score({ max: 1 })).toBe(0);
  expect(await score({ max: 2 })).toBe(1);
  expect(await score({ pattern: "database" })).toBe(1);
  expect(await score({ pattern: "database", min: 2 })).toBe(0);
  expect(await score({ pattern: "database", max: 1 })).toBe(1);
  expect(await score({ pattern: "colour" })).toBe(0);
  // No question: min 1 by default, and 0 when max is 0.
  const none = played(ran("a"));
  expect(await score({}, none)).toBe(0);
  expect(await score({ max: 0 }, none)).toBe(1);
  expect(await score({ max: 0 })).toBe(0);
  const missed = await checkScore(rule({ pattern: "colour", by: "main" }), two);
  expect(missed.reason).toContain(
    "0 matching questions, min 1, for /colour/ by main",
  );
  expect(missed.reason).toContain('asked: "Which database?", "Which port?"');
  expect((await checkScore(rule({}), none)).reason).toContain(
    "the agent asked no question",
  );
  expect((await checkScore(rule({ max: 1 }), two)).reason).toContain(
    "2 matching questions, max 1",
  );
  expect(await score({ by: "subagent" })).toBe(0);
  expect(await score({ by: { agent: "nobody" }, max: 0 })).toBe(0);
});

test("ended_awaiting_user reads the last main-agent event, and not a question call's result", async () => {
  const last = played(
    ran("a"),
    ask("Which?", "q"),
    result("q", "no one answered"),
  );
  expect(endsAwaiting(last.transcript, null)).toBe(true);
  const after = played(ask("Which?", "q"), result("q", ""), ran("b"));
  expect(endsAwaiting(after.transcript, undefined)).toBe(false);
  expect(endsAwaiting([], null)).toBe(false);
  // The adapter's own word is enough.
  expect(endsAwaiting(after.transcript, true)).toBe(true);
  expect(questionsIn(after.transcript)).toEqual([]);
  expect(questionsIn(last.transcript)).toEqual(["Which?"]);
  const check = { type: "ended_awaiting_user", weight: 1 } as RuledCheck;
  expect((await checkScore(check, last)).score).toBe(1);
  expect((await checkScore(check, after)).score).toBe(0);
});

test("the startup reports of every process are joined, a plugin once", () => {
  const none = {
    paths: null,
    skills: null,
    agents: null,
    rules: null,
    hooks: null,
    mcpServers: null,
  };
  expect(unionLoaded([none])).toEqual(none);
  const first = {
    ...none,
    skills: ["a"],
    plugins: [{ name: "p", path: "/p" }],
    rawSkills: ["p:a"],
  };
  const second = {
    ...none,
    skills: ["a", "b"],
    agents: ["x"],
    plugins: [{ name: "p", path: "/p" }],
  };
  expect(unionLoaded([first, second])).toEqual({
    ...none,
    skills: ["a", "b"],
    agents: ["x"],
    rawSkills: ["p:a"],
    plugins: [{ name: "p", path: "/p" }],
  });
});

test("a check that was not asked is left out of its rate", () => {
  const check = {
    type: "output_contains",
    text: "x",
    weight: 1,
    turn: 2,
  } as Check;
  const record = (score: number | null) =>
    ({
      checks: [
        score === null
          ? { ...check, score, notScored: true }
          : { ...check, score },
      ],
    }) as unknown as RunRecord;
  const rate = (valid: RunRecord[]) =>
    checkRate(check, 0, { valid, planned: 2 });
  expect(rate([record(null)])).toBe("not scored: turn 2 was not asked");
  expect(rate([record(1), record(null)])).toBe(
    "1/1 (not scored: turn 2 was not asked in 1 of 2 runs)",
  );
  expect(rate([record(1), record(0)])).toBe("1/2");
});
