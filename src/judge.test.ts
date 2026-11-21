import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { parseVerdict } from "./judge.js";
import { plantCase, plugin } from "./testing/plant.js";
import { readResults, sandbox, tableRow } from "./testing/sandbox.js";

const RUBRIC = "Says the word fixed and nothing about weather.";
const ANSWER = "It is fixed now.";
const JUDGE_MODEL = "judge-model";
const YES = '{"score": 1, "reason": "yes"}';

/** What the fake judge logged for one call. */
interface Asked {
  prompt: string;
  model: string | null;
  pluginDir: string | null;
}

/**
 * Compares two plugins that give the same answer, on a case with one judged and one deterministic check.
 * @param replies - What the fake judge answers, one entry for each call.
 * @param extra - More flags for `run`.
 * @returns What the command did, what the judge was asked, and the run records.
 */
async function judgedRun(replies: string[], ...extra: string[]) {
  const box = sandbox();
  const pluginA = plugin(box, "plugin-alpha", {
    costUsd: 0.01,
    answer: ANSWER,
  });
  const pluginB = plugin(box, "plugin-beta", { costUsd: 0.01, answer: ANSWER });
  const cases = plantCase(box, [
    { type: "judge", rubric: RUBRIC, weight: 3 },
    { type: "output_contains", text: "broken" },
  ]);
  box.write("fake/judge/replies.json", replies);
  const outDir = path.join(box.root, "results");
  const flags = ["--cases", cases, "--out", outDir, ...extra];
  const result = await box.cli(
    ["run", "--a", pluginA, "--b", pluginB, ...flags],
    {
      SKILL_EVALS_BIN_CODEX: path.join(box.root, "bin/fake-agent.mjs"),
    },
  );
  const asked = fs
    .readFileSync(path.join(box.root, "fake/judge/prompts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Asked);
  return { box, result, asked, records: readResults(outDir).records };
}

const REPLIES = [
  '{"score": 0.5, "reason": "half of it"}',
  "I would say it is quite good.",
  'Here you go:\n```json\n{"score": 1, "reason": "all of it {really}"}\n```',
  '{"score": 1.5, "reason": "more than all"}',
  '{"score": "high"}',
  '{"score": 0, "reason": "none of it"}',
];
const REPS_AND_MODEL = ["--reps", "2", "--model", "run-model"];

test("a judged check takes its score from the judge's reply, asked once more after an unusable one", async () => {
  const { result, records } = await judgedRun(REPLIES, ...REPS_AND_MODEL);
  expect(result.status, "one run has no score").toBe(1);

  const judged = records.map((record) => record.checks[0]);
  expect(judged.map((check) => check?.score)).toEqual([0.5, 1, null, 0]);
  expect(judged.map((check) => check?.reason)).toEqual([
    "half of it",
    "all of it {really}",
    'the judge gave no usable score: the score must be a number from 0 to 1, got "high"',
    "none of it",
  ]);
  expect(records.map((record) => record.score)).toEqual([0.375, 0.75, null, 0]);
  expect(records.map((record) => record.judge?.calls)).toEqual([1, 2, 2, 1]);
  expect(records[1]?.judge?.costUsd).toBe(0.004);
  expect(records[1]?.judge?.tokens).toEqual({ input: 2000, output: 100 });
  expect(records[1]?.costUsd, "the judge's cost stays out of the run's").toBe(
    0.01,
  );
});

test("the judge sees the task, the answer, and the rubric, and nothing about the subject", async () => {
  const { box, result, asked } = await judgedRun(REPLIES, ...REPS_AND_MODEL);

  expect(asked).toHaveLength(REPLIES.length);
  expect(new Set(asked.map((call) => call.prompt)).size).toBe(1);
  const prompt = asked[0]?.prompt;
  for (const part of ["say it in plain words", ANSWER, RUBRIC]) {
    expect(prompt).toContain(part);
  }
  const secrets = [
    box.root,
    "plugin-alpha",
    "plugin-beta",
    "claude-code",
    "run-model",
  ];
  for (const secret of secrets) expect(prompt).not.toContain(secret);
  expect(asked[0]?.model, "the judge model defaults to --model").toBe(
    "run-model",
  );
  expect(asked[0]?.pluginDir, "the judge runs with nothing loaded").toBeNull();

  expect(tableRow(result.stdout, "restate")).toMatch(
    /^\| restate \| 0\.38 \/ 0\.38 \(\+0\.00\) \| `judge "Says the word fixed[^`]*\(weight 3\)` A 0\.50, B 0\.50<br>`output_contains "broken"` A 0\/1, B 0\/2 \|/,
  );
  expect(result.stdout).toMatch(
    /^- Judge: the harness under test, model run-model$/m,
  );
  expect(result.stdout).toMatch(
    /^Judge, in total and not counted in the table: 6 calls, .*cost \$0\.0120$/m,
  );
  expect(result.stdout).toMatch(
    /^- A `restate` rep 2: a judged check has no score: the judge gave no usable score/m,
  );
});

test("the judge runs on the harness and the model that the judge flags name", async () => {
  const flags = [
    "--reps",
    "1",
    "--model",
    "run-model",
    "--judge-model",
    JUDGE_MODEL,
  ];
  const sameHarness = await judgedRun([YES, YES], ...flags);
  expect(sameHarness.result.status, sameHarness.result.stderr).toBe(0);
  expect(sameHarness.asked.map((call) => call.model)).toEqual([
    JUDGE_MODEL,
    JUDGE_MODEL,
  ]);

  // The fake speaks Claude Code's stream format, so a judge behind the Codex adapter yields no answer.
  const otherHarness = await judgedRun(
    Array<string>(4).fill(YES),
    ...flags,
    "--judge-harness",
    "codex",
  );
  expect(otherHarness.result.status).toBe(1);
  expect(otherHarness.asked, "two runs, each asked twice").toHaveLength(4);
  expect(otherHarness.records[0]?.checks[0]?.reason).toMatch(
    /no turn\.completed event/,
  );
  expect(otherHarness.result.stdout).toMatch(
    /^- Judge: codex, model judge-model$/m,
  );
  expect(otherHarness.result.stdout, "a judge that reports no cost").toMatch(
    /^Judge, in total and not counted in the table: 4 calls, duration [\d.]+ s$/m,
  );
});

test("a judged check of an invalid run is not sent to the judge", async () => {
  const box = sandbox();
  const ghost = plugin(box, "plugin-ghost", { ghost: true, answer: ANSWER });
  const cases = plantCase(box, [{ type: "judge", rubric: RUBRIC }]);
  box.write("fake/judge/replies.json", [YES]);
  const outDir = path.join(box.root, "results");
  const flags = ["--cases", cases, "--reps", "1", "--out", outDir];

  const result = await box.cli(["score", "--subject", ghost, ...flags]);
  expect(result.status).toBe(1);
  expect(readResults(outDir).records[0]?.checks[0]).toMatchObject({
    score: null,
    reason: "not judged, because the run is invalid",
  });
  expect(fs.existsSync(path.join(box.root, "fake/judge/prompts.jsonl"))).toBe(
    false,
  );
});

test("a verdict needs no reason, and a reason that is not text is kept as JSON", () => {
  expect(parseVerdict('{"score": 1}')).toEqual({ score: 1, reason: "" });
  expect(parseVerdict('{"score": 0, "reason": ["a", "b"]}')).toEqual({
    score: 0,
    reason: '["a","b"]',
  });
  expect(() => parseVerdict("{}")).toThrow(
    "the score must be a number from 0 to 1, got undefined",
  );
  expect(() => parseVerdict("null")).toThrow('no JSON object in "null"');
});
