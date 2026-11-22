import fs from "node:fs";
import { expect, test } from "vitest";
import path from "node:path";
import { plantCase } from "./testing/plant.js";
import { readResults, sandbox, tableRow } from "./testing/sandbox.js";
import {
  LOADS_BRO,
  WRITES_SUMMARY,
  compared,
  noiseFile,
} from "./testing/delta.js";

const WEIGHTED = [
  { ...LOADS_BRO, weight: 2 },
  { ...WRITES_SUMMARY, weight: 8 },
];
const HELPED = "helped (+0.20, 95% +0.20..+0.20)";
const WITHIN = "within noise (+0.20, 95% +0.20..+0.20)";
const NOISE = "--noise";

test("a case is judged against its own p95AbsDelta, and maxAbsDelta is information", async () => {
  const box = sandbox();
  // The maxAbsDelta would cover the delta, and p95AbsDelta does not.
  const file = noiseFile(box, { cases: { restate: 0.05 }, suite: 0.05 });
  const fileWide = box.write("wide.json", {
    ...JSON.parse(fs.readFileSync(file, "utf8")),
    perCase: { restate: { sd: 0.1, maxAbsDelta: 0.9, p95AbsDelta: 0.05 } },
  });
  const narrow = await compared(box, {
    checks: WEIGHTED,
    flags: [NOISE, fileWide],
  });
  expect(tableRow(narrow.ran.stdout, "restate")).toContain(HELPED);
  const covered = noiseFile(box, { cases: { restate: 0.25 }, suite: 0.25 });
  const within = await compared(box, {
    checks: WEIGHTED,
    flags: [NOISE, covered],
  });
  expect(tableRow(within.ran.stdout, "restate")).toContain(WITHIN);
});

test("a noise file calibrated on another harness is not applied, and the report says so", async () => {
  const box = sandbox();
  const file = noiseFile(
    box,
    { cases: { restate: 0.25 }, suite: 0.25 },
    { harness: "pi" },
  );
  const { ran } = await compared(box, {
    checks: WEIGHTED,
    flags: [NOISE, file],
  });
  expect(tableRow(ran.stdout, "restate")).toContain(HELPED);
  expect(ran.stdout).toContain("Suite delta: helped");
  expect(ran.stdout).toContain("calibrated on pi at 5 reps");
  expect(ran.stdout).toContain("It is not applied to claude-code");
});

test("the report notes a noise file made at other reps, and one from another suite", async () => {
  const box = sandbox();
  const file = noiseFile(
    box,
    { cases: { other: 0.25 }, suite: 0.25 },
    { reps: 3 },
  );
  const { ran } = await compared(box, {
    checks: WEIGHTED,
    flags: [NOISE, file],
  });
  expect(ran.stdout).toContain("This run uses 5 reps, not 3");
  expect(ran.stdout).toContain("No case of this suite is in the noise file");
  const same = noiseFile(box, { cases: { restate: 0.25 }, suite: 0.25 });
  const quiet = await compared(box, { checks: WEIGHTED, flags: [NOISE, same] });
  expect(quiet.ran.stdout).not.toContain("This run uses");
  expect(quiet.ran.stdout).not.toContain("No case of this suite");
});

test("with two harnesses the noise file applies to the one it was calibrated on, and to no other", async () => {
  const box = sandbox();
  const file = noiseFile(box, { cases: { restate: 0.25 }, suite: 0.25 });
  const cases = plantCase(box, [WRITES_SUMMARY]);
  const out = path.join(box.root, "results");
  const ran = await box.cli(
    [
      ...["run", "--a", "none", "--b", "none", "--reps", "5"],
      ...["--cases", cases, "--out", out, "--noise", file],
      ...["--harness", "claude-code,pi"],
    ],
    { SKILL_EVALS_BIN_PI: box.pi },
  );
  expect(ran.status, ran.stderr).toBe(0);
  const [first, second] = readResults(out).comparison?.harnesses ?? [];
  expect(first?.harness).toBe("claude-code");
  expect(first?.cases[0]?.noise).toBe(0.25);
  expect(first?.suite.noise).toBe(0.25);
  expect(second?.harness).toBe("pi");
  expect(second?.cases[0]?.noise).toBeNull();
  expect(second?.suite.noise).toBeNull();
  expect(ran.stdout).toContain("It is not applied to pi");
  // Pi is not listed as missing a case: it is a harness the file does not cover.
  expect(ran.stdout).not.toContain("judged by the interval alone: restate");
});
