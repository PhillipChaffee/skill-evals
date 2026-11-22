import { expect, test } from "vitest";
import { plantCase, plugin } from "./testing/plant.js";
import {
  PASS,
  FAIL,
  REPLIES_FILE,
  SCORE_ONE,
  judgedWith,
} from "./testing/judged.js";
import { sandbox } from "./testing/sandbox.js";

const WARNING =
  "skill-evals: warning: the judge is the model under test; set --judge-model or judgeModel";
const NO_ANSWER = "no idea";
const BINARY = "binary";

test("three votes, two pass, scores 1 and records all three", async () => {
  const { check, prompts } = await judgedWith(
    { rubric: "r", scale: BINARY, votes: 3 },
    [PASS, FAIL, PASS],
  );
  expect(prompts).toHaveLength(3);
  expect(check?.score).toBe(1);
  expect(check?.votes).toEqual([
    { score: 1, reason: "ok" },
    { score: 0, reason: "no" },
    { score: 1, reason: "ok" },
  ]);
  expect(check?.reason).toBe("2 of 3 votes pass");
});

test("a single vote records no votes", async () => {
  const { check } = await judgedWith({ rubric: "r", scale: BINARY }, [FAIL]);
  expect(check).toMatchObject({ score: 0, reason: "no" });
  expect(check).not.toHaveProperty("votes");
});

test("0-1 votes score the median", async () => {
  const { check } = await judgedWith({ rubric: "r", votes: 3 }, [
    '{"score": 0.2, "reason": "a"}',
    '{"score": 0.9, "reason": "b"}',
    '{"score": 0.6, "reason": "c"}',
  ]);
  expect(check?.score).toBe(0.6);
});

test("an unusable vote is recorded and left out; an even usable count that ties scores 0", async () => {
  const { check } = await judgedWith({ rubric: "r", scale: BINARY, votes: 3 }, [
    PASS,
    FAIL,
    NO_ANSWER,
    "still no idea",
  ]);
  expect(check?.score).toBe(0);
  expect(check?.votes?.[2]).toMatchObject({ score: null });
  expect(check?.votes?.[2]?.reason).toMatch(/no usable score/);
  expect(check?.reason).toBe(
    "1 of 2 votes pass, a tie scores 0; 1 vote gave no usable answer",
  );
});

test("0-1 votes with an even usable count take the middle two's mean", async () => {
  const { check } = await judgedWith({ rubric: "r", votes: 3 }, [
    '{"score": 0.2}',
    '{"score": 0.6}',
    "x",
    "y",
  ]);
  expect(check?.score).toBeCloseTo(0.4);
});

test("no usable vote leaves the check unscored", async () => {
  const { check } = await judgedWith(
    { rubric: "r", votes: 3 },
    Array<string>(6).fill("nope"),
  );
  expect(check?.score).toBeNull();
  expect(check?.votes).toHaveLength(3);
  expect(check?.reason).toMatch(/^the judge gave no usable score/);
});

test("structured rubric becomes pass/fail sections", async () => {
  const { prompts, check } = await judgedWith(
    {
      rubric: { pass: "Names the file.", fail: "Names none." },
      scale: BINARY,
    },
    [PASS],
  );
  expect(prompts[0]).toContain(
    "<rubric>\nPasses when:\nNames the file.\n\nFails when:\nNames none.\n</rubric>",
  );
  expect(prompts[0]).toContain('"verdict": "pass" | "fail"');
  expect(prompts[0]).not.toContain("Give a score from 0 to 1");
  expect(check?.score).toBe(1);
});

test("a binary reply that is neither pass nor fail is unusable", async () => {
  const { check } = await judgedWith({ rubric: "r", scale: BINARY }, [
    '{"verdict": "maybe"}',
    SCORE_ONE,
  ]);
  expect(check?.score).toBeNull();
  expect(check?.reason).toMatch(/the verdict must be "pass" or "fail"/);
});

test("the same-model warning prints once", async () => {
  const box = sandbox();
  const owned = plugin(box, "plugin-owned", { answer: "x" });
  const cases = plantCase(box, [
    { type: "judge", rubric: "r" },
    { type: "judge", rubric: "r2" },
  ]);
  box.write(REPLIES_FILE, Array<string>(2).fill('{"score": 1}'));
  const base = ["score", "--subject", owned, "--cases", cases, "--reps", "2"];
  const same = await box.cli([...base, "--out", `${box.root}/o1`]);
  expect(same.stderr.split(WARNING)).toHaveLength(2);
  box.write(REPLIES_FILE, Array<string>(4).fill('{"score": 1}'));
  const named = await box.cli([
    ...base,
    "--out",
    `${box.root}/o2`,
    "--model",
    "m",
    "--judge-model",
    "j",
  ]);
  expect(named.stderr).not.toContain("warning");
  const equal = await box.cli([
    ...base,
    "--out",
    `${box.root}/o3`,
    "--model",
    "m",
    "--judge-model",
    "m",
  ]);
  expect(equal.stderr).toContain(WARNING);
  const defaulted = await box.cli([
    ...base,
    "--out",
    `${box.root}/o4`,
    "--model",
    "m",
  ]);
  expect(defaulted.stderr).toContain(WARNING);
});

test("no warning without a judge check", async () => {
  const box = sandbox();
  const owned = plugin(box, "plugin-owned", { answer: "x" });
  const cases = plantCase(box, [{ type: "output_contains", text: "x" }]);
  const ran = await box.cli([
    "score",
    "--subject",
    owned,
    "--cases",
    cases,
    "--reps",
    "1",
    "--out",
    `${box.root}/o`,
  ]);
  expect(ran.stderr).not.toContain("warning");
});
