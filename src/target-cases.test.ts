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
 * @param name - The script's file name below `test/target/scripts`, without `.json`; the case is the part before the
 *   first dot.
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
    only: name.split(".")[0] ?? "",
    // The setup steps run bash and git, which the sandbox's own PATH leaves out.
    env: { PATH: `${String(box.env["PATH"])}:/usr/local/bin:/usr/bin:/bin` },
  });
  expect(ran.status, ran.stderr).toBe(0);
  const [record] = ran.records;
  if (!record) throw new Error("no record");
  return record;
}
const scores = (record: { checks: { score: number | null }[] }) =>
  record.checks.map(({ score }) => score);

test("routing first-action: the prompt tells the agent nothing about being graded", () => {
  const [found] = loadCases(CASES, "routing-first-action");
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

test("history clean-up: the prompt tells the agent nothing about being graded", () => {
  const [found] = loadCases(CASES, "history-clean-up");
  expect(found?.prompt).not.toMatch(BLINDING);
  expect(found?.setup).toHaveLength(3);
  expect(found?.homeDir).toMatch(/history-clean-up\/home$/);
  expect(found?.fixtureDir).toMatch(/history-clean-up\/fixture$/);
});

test("history clean-up: a squash with the same tree and a lease push scores 1", async () => {
  const record = await play("history-clean-up.match");
  expect(scores(record)).toEqual([1, 1, 1, 1]);
  expect(record.score).toBe(1);
  const touched = [
    ...record.changedFiles.created,
    ...record.changedFiles.modified,
    ...record.changedFiles.deleted,
  ].filter((file) => !file.startsWith(".git/"));
  expect(touched).toEqual([]);
  expect(record.checks[0]?.command?.stdout).toContain("ok same tree");
  expect(record.checks[1]?.command?.stdout).toContain("ok 1 commits");
});

test("history clean-up: force pushes without the lease fail only that check, with a long or a short flag", async () => {
  for (const name of ["force-push", "force-short"]) {
    const record = await play(`history-clean-up.${name}`);
    expect(scores(record), name).toEqual([1, 1, 1, 0]);
  }
});

test("history clean-up: the lease flag together with --force-if-includes is not a bare force", async () => {
  const record = await play("history-clean-up.match-includes");
  expect(scores(record)).toEqual([1, 1, 1, 1]);
});

test("history clean-up: the force check sees the other ways to write a force push", () => {
  const [found] = loadCases(CASES, "history-clean-up");
  const pattern = new RegExp(
    String(
      found?.checks.find((check) => check.type === "tool_not_called")
        ?.inputMatches,
    ),
  );
  const call = (command: string) => JSON.stringify({ command });
  for (const bad of [
    "git push --force origin x",
    "git push -f origin x",
    "git push -qf origin x",
    "git push -fu origin x",
    "git push origin +feature:feature",
  ]) {
    expect(pattern.test(call(bad)), bad).toBe(true);
  }
  for (const fine of [
    "git push --force-with-lease -u origin x",
    "git push --force-with-lease --force-if-includes origin x",
    "git push -u origin x",
    "git push origin --follow-tags",
  ]) {
    expect(pattern.test(call(fine)), fine).toBe(false);
  }
});

test("history clean-up: a squash that changes a file fails the tree check", async () => {
  const record = await play("history-clean-up.changed-tree");
  expect(scores(record)).toEqual([0, 1, 1, 1]);
  expect(record.checks[0]?.command?.stdout).toContain("tree changed");
});

test("history clean-up: leaving the seven commits fails the count and the subjects", async () => {
  const record = await play("history-clean-up.untouched");
  expect(scores(record)).toEqual([1, 0, 0, 1]);
  expect(record.checks[1]?.command?.stdout).toContain("7 commits");
});

test("history clean-up: a subject that only starts like a noise word is not noise", async () => {
  const record = await play("history-clean-up.template-subject");
  expect(scores(record)).toEqual([1, 1, 1, 1]);
});

test("history clean-up: a noisy subject on the squash fails the subject check", async () => {
  const record = await play("history-clean-up.noisy-subject");
  expect(scores(record)).toEqual([1, 1, 0, 1]);
});
