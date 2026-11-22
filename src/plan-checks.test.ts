import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { sandbox } from "./testing/sandbox.js";
import { linesIn, plantSuite } from "./testing/suite.js";

const ids = ["alpha", "bravo", "charlie"];

test("plan raises the usage errors that the command would, before it prints anything", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids);
  const base = ["--cases", cases, "--reps", "1"];
  const missing = await box.cli([
    "plan",
    "--a",
    "nosuchref",
    "--b",
    "none",
    ...base,
  ]);
  expect(missing.status).toBe(2);
  expect(missing.stdout).toBe("");
  const noPrompt = await box.cli([
    "run",
    "--a",
    "nosuchref",
    "--b",
    "none",
    ...base,
    "--dry-run",
  ]);
  expect(noPrompt.status).toBe(2);
  const isolated = await box.cli([
    "plan",
    "--subject",
    "none",
    "--isolated",
    ...base,
  ]);
  expect(isolated.stdout).toContain("Runs: 3");
  const withFlags = await box.cli([
    ...[
      "plan",
      "--subject",
      "none",
      "--model",
      "m",
      "--judge-model",
      "j",
      "--min-score",
      "0.5",
    ],
    ...base,
  ]);
  expect(withFlags.status, withFlags.stderr).toBe(0);
});

test("plan estimates from valid runs only, the last of each run", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  const out = path.join(box.root, "results");
  const args = ["--subject", "none", "--cases", cases];
  const first = await box.cli(["score", ...args, "--reps", "3", "--out", out]);
  expect(first.status, first.stderr).toBe(0);
  const lines = linesIn(out).map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  const costed = (index: number, cost: number, more: object = {}): string =>
    JSON.stringify({ ...lines[index], costUsd: cost, ...more });
  // Rep 1 was run again and cost 5; rep 2 cost 3; rep 3 failed and cost 100.
  fs.writeFileSync(
    path.join(out, "results.jsonl"),
    `${[costed(0, 1), costed(0, 5), costed(1, 3), costed(2, 100, { error: "crashed" })].join("\n")}\n`,
  );
  const ran = await box.cli(["plan", ...args, "--reps", "4", "--resume", out]);
  expect(ran.status, ran.stderr).toBe(0);
  // Reps 1 and 2 are reused. Rep 3 failed, and rep 4 is new. Each is estimated at the median of 5 and 3.
  expect(ran.stdout).toContain("2 of 4 runs would be reused");
  expect(ran.stdout).toContain("- cost: $8.00 (from 2 of 2 runs)");
  expect(ran.stdout).toContain("estimate covers 2 of 2 runs");
});

test("a valid record that a later invalid line replaced does not feed the medians", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  const out = path.join(box.root, "results");
  const args = ["--subject", "none", "--cases", cases];
  await box.cli(["score", ...args, "--reps", "2", "--out", out]);
  const lines = linesIn(out).map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  const line = (index: number, cost: number, more: object = {}): string =>
    JSON.stringify({ ...lines[index], costUsd: cost, ...more });
  // Rep 1 cost 10 and was run again, and failed at 99; rep 2 cost 2.
  fs.writeFileSync(
    path.join(out, "results.jsonl"),
    `${[line(0, 10), line(0, 99, { error: "crashed" }), line(1, 2)].join("\n")}\n`,
  );
  const ran = await box.cli(["plan", ...args, "--reps", "3", "--resume", out]);
  expect(ran.status, ran.stderr).toBe(0);
  // Rep 3 is the only run left to estimate, besides rep 1, which failed: both at the median of the only valid run, 2.
  expect(ran.stdout).toContain("1 of 3 runs would be reused");
  expect(ran.stdout).toContain("- cost: $4.00 (from 2 of 2 runs)");
});
