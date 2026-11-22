import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { scoreSubject } from "./testing/runs.js";
import { sandbox } from "./testing/sandbox.js";

// The target cases of the design: real cases kept in test/target, each played by scripts that stand in for the agent.
const TARGET = path.resolve(import.meta.dirname, "../test/target");
const CASES = path.join(TARGET, "cases");
const BLINDING =
  /eval|test|judge|experiment|rubric|score|compare|benchmark|candidate|arena/i;

/**
 * Plays one script of a target case against its subject.
 * @param name - The script's file name below `test/target/scripts`, without `.json`.
 * @returns The run record.
 */
async function play(name: string) {
  const box = sandbox();
  box.write(
    `fake/scripts/${name}.json`,
    fs.readFileSync(path.join(TARGET, "scripts", `${name}.json`), "utf8"),
  );
  const ran = await scoreSubject(box, {
    subject: path.join(TARGET, "subject"),
    cases: CASES,
  });
  expect(ran.status, ran.stderr).toBe(0);
  const [record] = ran.records;
  if (!record) throw new Error("no record");
  return record;
}
const scores = (record: { checks: { score: number | null }[] }) =>
  record.checks.map(({ score }) => score);

test("routing first-action: the prompt tells the agent nothing about being graded", () => {
  const [found] = loadCases(CASES);
  expect(found?.id).toBe("routing-first-action");
  expect(found?.prompt).not.toMatch(BLINDING);
});

test("routing first-action: the matching script scores 1", async () => {
  const record = await play("routing-first-action.match");
  expect(scores(record)).toEqual([1, 1, 1]);
  expect(record.score).toBe(1);
  expect(
    record.skillEvents.map(({ skill, via, type }) => [skill, via, type]),
  ).toEqual([
    ["bug-fix", "file_read", "file_read"],
    ["bug-fix", "skill_tool", "load"],
  ]);
});

test("routing first-action: the wrong skill fails the check that keeps the nearby skill out", async () => {
  const record = await play("routing-first-action.wrong-skill");
  expect(record.checks[1]).toMatchObject({
    type: "skill_not_loaded",
    skill: "refactor",
    score: 0,
  });
  expect(record.score).toBeLessThan(1);
});

test("routing first-action: an edit before the skill fails the first-skill check", async () => {
  const record = await play("routing-first-action.edit-before-skill");
  expect(record.checks[0]).toMatchObject({
    type: "skill_loaded",
    first: true,
    score: 0,
  });
  expect(record.checks[0]?.reason).toMatch(
    /call #0 comes before the first skill load \(call #1\)/,
  );
  expect(scores(record)).toEqual([0, 1, 1]);
});

test("routing first-action: loading the nearby skill after the entry skill fails only the check that keeps it out", async () => {
  const record = await play("routing-first-action.wrong-skill-after");
  expect(scores(record)).toEqual([1, 0, 1]);
});
