import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { median } from "./commands/plan-estimate.js";
import { plugin } from "./testing/plant.js";
import { sandbox } from "./testing/sandbox.js";
import { SUMMARY, plantSuite, startsOf } from "./testing/suite.js";

const ids = ["alpha", "bravo", "charlie"];
const RESULTS = "results.json";

test("plan prints the run count and spends nothing", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids);
  const out = path.join(box.root, "never");
  const ran = await box.cli([
    ...["plan", "--subject", "none", "--cases", cases, "--reps", "2"],
    ...["--jobs", "4"],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("Runs: 6");
  expect(ran.stdout).toContain("- claude-code: 3 cases x 1 subjects = 6 runs");
  expect(ran.stdout).toContain("Subjects (1): subject = none");
  expect(ran.stdout).not.toContain("Estimate");
  expect(startsOf(box)).toBe(0);
  expect(fs.existsSync(out)).toBe(false);
});

test("plan with two subjects counts both, and a case's own reps wins", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids);
  box.write("suite/bravo/case.json", {
    checks: [SUMMARY],
    reps: 5,
  });
  const ran = await box.cli([
    "plan",
    "--a",
    "none",
    "--cases",
    cases,
    "--b",
    "none",
    "--reps",
    "1",
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("Runs: 14");
  expect(ran.stdout).toContain("Subjects (2): a = none, b = none");
});

test("--dry-run on score and run prints the plan and exits 0", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids);
  const plain = await box.cli([
    "plan",
    "--subject",
    "none",
    "--cases",
    cases,
    "--reps",
    "1",
  ]);
  const score = await box.cli([
    "score",
    "--subject",
    "none",
    "--cases",
    cases,
    "--reps",
    "1",
    "--dry-run",
  ]);
  expect(score.status, score.stderr).toBe(0);
  expect(score.stdout).toBe(plain.stdout);
  const run = await box.cli([
    "run",
    "--a",
    "none",
    "--b",
    "none",
    "--cases",
    cases,
    "--reps",
    "1",
    "--dry-run",
  ]);
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain("Runs: 6");
  expect(startsOf(box)).toBe(0);
  expect(run.stderr).toBe("");
});

test("plan lists the cases that are not applicable", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  box.write("suite/only-codex/prompt.md", "do it\n");
  box.write("suite/only-codex/case.json", {
    checks: [SUMMARY],
    harnesses: ["codex"],
    note: "codex only",
  });
  const ran = await box.cli([
    "plan",
    "--subject",
    "none",
    "--cases",
    cases,
    "--reps",
    "1",
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("Not applicable (no runs, no score):");
  expect(ran.stdout).toMatch(/- claude-code only-codex: .*codex only/);
  expect(ran.stdout).toContain("Runs: 1");
});

test("plan fails as the command would for a wrong option", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids);
  const ran = await box.cli([
    "plan",
    "--subject",
    "none",
    "--cases",
    cases,
    "--jobs",
    "0",
  ]);
  expect(ran.status).toBe(2);
  const nothing = await box.cli([
    "plan",
    "--subject",
    "none",
    "--cases",
    path.join(box.root, "none"),
  ]);
  expect(nothing.status).toBe(2);
});

/**
 * Scores the suite once into `results`, with a plugin that may report a cost.
 * @param box - The sandbox.
 * @param cost - What the plugin reports each run costs; null for none.
 * @returns The cases directory, the plugin directory and the output directory.
 */
async function scored(box: ReturnType<typeof sandbox>, cost: number | null) {
  const cases = plantSuite(box, ids);
  const kit = plugin(box, "kit", cost === null ? {} : { costUsd: cost });
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    "score",
    "--subject",
    kit,
    "--cases",
    cases,
    "--reps",
    "2",
    "--out",
    out,
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  return { cases, kit, out };
}

test("plan estimates cost and duration from the medians of an earlier command", async () => {
  const box = sandbox();
  const { cases, kit, out } = await scored(box, 0.5);
  box.write("suite/delta/prompt.md", "new\n");
  box.write("suite/delta/case.json", {
    checks: [SUMMARY],
  });
  const started = startsOf(box);
  const ran = await box.cli([
    "plan",
    "--subject",
    kit,
    "--cases",
    cases,
    "--reps",
    "3",
    "--resume",
    out,
    "--jobs",
    "2",
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("Runs: 12");
  // Three of the four cases ran before: 9 of the 12 planned runs are covered, each at its median of $0.50.
  expect(ran.stdout).toContain("estimate covers 9 of 12 runs");
  expect(ran.stdout).toContain("- cost: $4.50");
  expect(ran.stdout).toMatch(/- duration: \d+:\d\d \(mm:ss\) at --jobs 2/);
  expect(startsOf(box)).toBe(started);
});

test("plan reads --out too, and falls back on results.json", async () => {
  const box = sandbox();
  const { cases, kit, out } = await scored(box, null);
  const args = [
    "plan",
    "--subject",
    kit,
    "--cases",
    cases,
    "--reps",
    "1",
    "--out",
    out,
  ];
  const first = await box.cli(args);
  expect(first.stdout).toContain("estimate covers 3 of 3 runs");
  expect(first.stdout).toContain(
    "- cost: unknown, no earlier run reported a cost",
  );
  fs.rmSync(path.join(out, "results.jsonl"));
  const second = await box.cli(args);
  expect(second.stdout).toContain("estimate covers 3 of 3 runs");
  fs.writeFileSync(path.join(out, RESULTS), "{not json");
  const broken = await box.cli(args);
  expect(broken.status).toBe(2);
  expect(broken.stderr).toContain("cannot be read as results");
  fs.writeFileSync(path.join(out, RESULTS), "{}");
  expect((await box.cli(args)).status).toBe(2);
  fs.rmSync(path.join(out, RESULTS));
  const none = await box.cli(args);
  expect(none.status, none.stderr).toBe(0);
  expect(none.stdout).not.toContain("Estimate");
});

test("plan with --resume on a directory with no results.jsonl is a usage error", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids);
  const ran = await box.cli([
    "plan",
    "--subject",
    "none",
    "--cases",
    cases,
    "--resume",
    box.root,
  ]);
  expect(ran.status).toBe(2);
});

test("the median of an even count is the mean of the two middle values", () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

test("plan names the project as the default subject, and main as the baseline of a comparison", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  const alone = await box.cli(["plan", "--cases", cases, "--reps", "1"]);
  expect(alone.stdout).toContain(`Subjects (1): subject = ${box.root}`);
  const pair = await box.cli([
    ...["plan", "--b", "none", "--cases", cases, "--reps", "1"],
  ]);
  expect(pair.stdout).toContain("Subjects (2): a = main, b = none");
});
