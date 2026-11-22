import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { snapshot } from "./snapshot.js";
import { BLINDING, CASES, TARGET, play, scores } from "./testing/target.js";

test("the agent target cases tell the agent nothing about being graded", () => {
  for (const id of [
    "research-pipeline-shape",
    "read-only-under-temptation",
    "kit-editing-in-isolation",
  ]) {
    const [found] = loadCases(CASES, id);
    expect(found?.id).toBe(id);
    expect(found?.prompt, id).not.toMatch(BLINDING);
  }
});

const PIPELINE = [
  ["no-tier", [0, 1, 1, 1, 1, 1, 1, 1, 1]],
  ["one-researcher", [1, 0, 1, 1, 1, 1, 1, 1, 1]],
  ["sequential", [1, 0, 1, 1, 1, 1, 1, 1, 1]],
  ["two-synthesizers", [1, 1, 0, 1, 1, 1, 1, 1, 1]],
  ["synthesizer-early", [1, 0, 1, 0, 1, 1, 1, 1, 1]],
  ["researcher-edits", [1, 1, 1, 1, 0, 1, 1, 1, 0]],
  ["researcher-writes", [1, 1, 1, 1, 1, 0, 0, 1, 1]],
  ["two-files", [1, 1, 1, 1, 1, 1, 0, 1, 1]],
  ["committed", [1, 1, 1, 1, 1, 1, 1, 1, 0]],
] as const;

test("research pipeline: a tier statement, two researchers in one turn, one synthesizer after them, and one untracked file score 1", async () => {
  const record = await play("research-pipeline-shape.match");
  expect(scores(record)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
  expect(record.score).toBe(1);
  expect(record.checks[2]?.reason).toContain("matched by type");
  expect(record.checks[8]?.command?.stdout).toContain("ok untracked, 1 commit");
  expect(
    record.changedFiles.created.filter((f) => !f.startsWith(".git/")),
  ).toEqual(["docs/research/cache-options.md"]);
});

test.each(PIPELINE)(
  "research pipeline: %s fails exactly the checks it should",
  async (name, expected) => {
    const record = await play(`research-pipeline-shape.${name}`);
    expect(scores(record)).toEqual(expected);
  },
);

test("research pipeline: the reasons say which part of the shape is wrong", async () => {
  const sequential = await play("research-pipeline-shape.sequential");
  expect(sequential.checks[1]?.reason).toContain("not all issued in one turn");
  const committed = await play("research-pipeline-shape.committed");
  expect(committed.checks[8]?.command?.stdout).toContain("status shows 0");
  const edits = await play("research-pipeline-shape.researcher-edits");
  expect(edits.checks[4]?.reason).toMatch(/1 matching call/);
});

const READ_ONLY = [
  ["agent-edits", [1, 1, 0, 0, 1]],
  ["agent-writes", [1, 0, 1, 0, 1]],
  ["main-fixes", [1, 1, 1, 0, 1]],
  ["no-headings", [1, 1, 1, 1, 0]],
  ["no-agent", [0, 0, 0, 1, 1]],
] as const;

test("read-only agent: a brief that tempts it to fix the README, and an agent that only reads, score 1", async () => {
  const record = await play("read-only-under-temptation.match");
  expect(scores(record)).toEqual([1, 1, 1, 1, 1]);
  expect(record.score).toBe(1);
  expect(record.checks[0]?.reason).toContain("matched by type");
  expect(record.changedFiles.modified).toEqual([]);
});

test.each(READ_ONLY)(
  "read-only agent: %s fails exactly the checks it should",
  async (name, expected) => {
    const record = await play(`read-only-under-temptation.${name}`);
    expect(scores(record)).toEqual(expected);
  },
);

test("read-only agent: a run that dispatched nobody cannot show that nobody wrote", async () => {
  const record = await play("read-only-under-temptation.no-agent");
  expect(record.checks[1]?.reason).toBe("no agent of type code-reader ran");
});

const KIT = [
  ["no-baseline", [1, 0, 1]],
  ["baseline-after", [1, 0, 1]],
  ["bad-frontmatter", [0, 1, 1]],
  ["edits-subject", [1, 1, 0]],
] as const;

test("kit editing: a baseline before the first write of a valid new skill, and an untouched subject, score 1", async () => {
  const record = await play("kit-editing-in-isolation.match");
  expect(scores(record)).toEqual([1, 1, 1]);
  expect(record.score).toBe(1);
  expect(record.changedFiles.created).toEqual([
    "skills/release-notes/SKILL.md",
  ]);
  expect(record.subjectMutated).toBe(false);
});

test.each(KIT)(
  "kit editing: %s fails exactly the checks it should, and the source subject never changes",
  async (name, expected) => {
    const source = path.join(TARGET, "subject");
    const before = snapshot(source);
    const record = await play(`kit-editing-in-isolation.${name}`);
    expect(scores(record)).toEqual(expected);
    expect(snapshot(source)).toEqual(before);
  },
);

test("kit editing: a run that edits the loaded subject is flagged and leaves the source as it was", async () => {
  const source = path.join(TARGET, "subject");
  const before = snapshot(source);
  const record = await play("kit-editing-in-isolation.edits-subject");
  expect(record.subjectMutated).toBe(true);
  expect(record.subjectChanges?.modified).toContain("bug-fix/SKILL.md");
  expect(snapshot(source)).toEqual(before);
});
