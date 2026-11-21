import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { script } from "./testing/plant.js";
import type { Sandbox } from "./testing/sandbox.js";
import { readResults, sandbox, seenBy, tableRow } from "./testing/sandbox.js";

const CASE_MODEL = "case-model";
const CASE_JUDGE = "case-judge";
const GUARDED = "watch/guarded";
const CHECKS = [{ type: "output_contains", text: "x" }];

/**
 * Plants one case directory.
 * @param box - Where to write it.
 * @param id - The path of the case under `cases/`.
 * @param more - Other keys of its case file.
 */
function plant(box: Sandbox, id: string, more: Record<string, unknown> = {}) {
  box.write(`cases/${id}/prompt.md`, `# ${id}\n\ndo it\n`);
  box.write(`cases/${id}/case.json`, { checks: CHECKS, ...more });
}

/**
 * Scores the planted cases once with no skills.
 * @param box - The sandbox, with its cases planted.
 * @param flags - More flags.
 * @returns The results, and the output directory.
 */
async function scored(box: Sandbox, ...flags: string[]) {
  const outDir = path.join(box.root, "results");
  const result = await box.cli([
    "score",
    "--subject",
    "none",
    "--cases",
    path.join(box.root, "cases"),
    "--out",
    outDir,
    ...flags,
  ]);
  expect(result.status, result.stderr).toBe(0);
  return { result, outDir, results: readResults(outDir) };
}

test("per-case reps overrides --reps, and nested ids make nested output directories", async () => {
  const box = sandbox();
  plant(box, "group/once", { reps: 1 });
  plant(box, "group/default");
  const { outDir, results } = await scored(box, "--reps", "3");
  const count = (id: string) =>
    results.records.filter((record) => record.caseId === id).length;
  expect(count("group/once")).toBe(1);
  expect(count("group/default")).toBe(3);
  expect(
    fs.existsSync(
      path.join(outDir, "claude-code/group/once/subject1.final.md"),
    ),
  ).toBe(true);
});

test("a case's model overrides --model for its agent runs, and judgeModel the judge's", async () => {
  const box = sandbox();
  plant(box, "own", { model: CASE_MODEL, judgeModel: CASE_JUDGE });
  plant(box, "inherits");
  box.write("cases/own/case.json", {
    checks: [{ type: "judge", rubric: "fine" }],
    model: CASE_MODEL,
    judgeModel: CASE_JUDGE,
  });
  box.write("fake/judge/replies.json", ['{"score": 1, "reason": "ok"}']);
  const { results } = await scored(
    box,
    "--model",
    "flag-model",
    "--judge-model",
    "flag-judge",
    "--reps",
    "1",
  );
  const modelOf = (id: string) =>
    seenBy(results.records.find((r) => r.caseId === id)?.finalText ?? "").model;
  expect(modelOf("own")).toBe(CASE_MODEL);
  expect(modelOf("inherits")).toBe("flag-model");
  const asked = fs
    .readFileSync(path.join(box.root, "fake/judge/prompts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { model: string }).model);
  expect(asked).toEqual([CASE_JUDGE]);
});

test("a case's env is set for the agent, and the parent's value of the same name is not passed through", async () => {
  const box = sandbox();
  script(box, "env", {
    turns: [
      [
        {
          call: {
            name: "Bash",
            input: { command: 'echo "$CASE_MARK|$TZ|$CASE_PARENT" > env.txt' },
            exec: true,
          },
        },
      ],
    ],
  });
  box.write("cases/envy/prompt.md", "# envy\n\ndo it\n");
  box.write("cases/envy/case.json", {
    checks: [
      { type: "file_matches", path: "env.txt", pattern: "^set\\|UTC\\|\\s*$" },
    ],
    env: { CASE_MARK: "set", TZ: "UTC" },
  });
  const outDir = path.join(box.root, "results");
  const result = await box.cli(
    [
      "score",
      "--subject",
      "none",
      "--cases",
      path.join(box.root, "cases"),
      "--out",
      outDir,
      "--reps",
      "1",
    ],
    { CASE_PARENT: "leak", TZ: "Asia/Tokyo" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(readResults(outDir).records[0]?.score).toBe(1);
});

test("results.json records each case's metadata and overrides", async () => {
  const box = sandbox();
  plant(box, "g/one", {
    tags: ["smoke"],
    targets: ["bro"],
    guard: true,
    kind: "trigger",
    description: "Shows it.",
    reps: 1,
    model: "m",
    judgeModel: "j",
    env: { CASE_A: "1" },
    "x-owner": "ops",
  });
  plant(box, "g/two");
  const { results } = await scored(box, "--reps", "2");
  expect(results.caseMeta["g/one"]).toEqual({
    extensions: { "x-owner": "ops" },
    tags: ["smoke"],
    targets: ["bro"],
    guard: true,
    kind: "trigger",
    description: "Shows it.",
    reps: 1,
    model: "m",
    judgeModel: "j",
    env: { CASE_A: "1" },
  });
  expect(results.caseMeta["g/two"]).toEqual({
    extensions: {},
    tags: [],
    targets: [],
    guard: false,
    kind: null,
    description: null,
    reps: null,
    model: null,
    judgeModel: null,
    env: {},
  });
});

test("the report lists guard cases in their own table and keeps their scores in the suite", async () => {
  const box = sandbox();
  plant(box, "dev-case", { targets: ["bro"] });
  plant(box, GUARDED, { guard: true, targets: ["bro"] });
  const { result } = await scored(box, "--reps", "1");
  const [main, guards] = result.stdout.split("### Guard cases");
  expect(tableRow(main ?? "", "dev-case")).not.toBe("");
  expect(tableRow(main ?? "", GUARDED)).toBe("");
  expect(tableRow(guards ?? "", GUARDED)).not.toBe("");
  expect(result.stdout).toContain("(2 of 2 cases)");
  expect(result.stdout).toContain("## Coverage by target skill");
  expect(tableRow(result.stdout, "bro")).toBe("| bro | 2 | 1 | 0 | 1 |");
});

test("a tag selection applies to run and score too", async () => {
  const box = sandbox();
  plant(box, "a", { tags: ["fast"] });
  plant(box, "b");
  const { results } = await scored(box, "--tag", "fast", "--reps", "1");
  expect(results.records.map((record) => record.caseId)).toEqual(["a"]);
});
