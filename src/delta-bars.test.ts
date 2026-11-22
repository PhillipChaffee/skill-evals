import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { EXIT } from "./exit-codes.js";
import { plantCase, plugin } from "./testing/plant.js";
import { sandbox, tableRow } from "./testing/sandbox.js";
import {
  LOADS_BRO,
  WRITES_SUMMARY,
  compared,
  readJson,
} from "./testing/delta.js";

const readText = (out: string, file: string): string =>
  fs.readFileSync(path.join(out, file), "utf8");
const MIN_DELTA = "--min-delta";
const WEIGHTED = [
  { ...LOADS_BRO, weight: 2 },
  { ...WRITES_SUMMARY, weight: 8 },
];

test("--min-delta fails a run whose delta is 0", async () => {
  const box = sandbox();
  const same = plugin(box, "plugin-same", { skill: "bro" });
  const missed = await compared(box, {
    checks: [WRITES_SUMMARY],
    a: same,
    b: same,
    flags: [MIN_DELTA, "0.1"],
  });
  expect(missed.ran.status).toBe(EXIT.bar);
  expect(missed.results?.belowBar).toEqual([
    "claude-code: suite delta +0.00 does not reach --min-delta +0.10",
  ]);
  expect(missed.ran.stdout).toContain("Below the pass bar:");
  expect(missed.results?.minDelta).toBe(0.1);
  // A delta of 0 reaches a bar of 0, and a bar below 0 lets B score lower.
  for (const flags of [[MIN_DELTA, "0"], ["--min-delta=-0.1"]]) {
    const reached = await compared(box, {
      checks: [WRITES_SUMMARY],
      a: same,
      b: same,
      flags,
    });
    expect(reached.ran.status, flags.join(" ")).toBe(0);
  }
});

test("a bar is on the point delta, and a negative delta misses a bar of 0", async () => {
  const box = sandbox();
  const worse = await compared(box, {
    checks: WEIGHTED,
    a: plugin(box, "plugin-loader", { skill: "bro" }),
    b: plugin(box, "plugin-plain", {}),
    flags: ["--min-delta=-0.1"],
  });
  expect(worse.ran.status).toBe(EXIT.bar);
  expect(worse.results?.belowBar).toEqual([
    "claude-code: suite delta −0.20 does not reach --min-delta −0.10",
  ]);
});

test("a case's minDelta is a bar for that case, and a missed bar is a failure in JUnit", async () => {
  const box = sandbox();
  const { ran, out, results } = await compared(box, {
    checks: WEIGHTED,
    more: { minDelta: 0.5 },
    flags: ["--report", "md,junit"],
  });
  expect(ran.status).toBe(EXIT.bar);
  expect(results?.belowBar).toEqual([
    "claude-code: case `restate` delta +0.20 does not reach its minDelta +0.50",
  ]);
  const xml = readText(out, "report.xml");
  expect(xml).toContain("delta +0.20 is below the case&#39;s minDelta +0.50");
  expect(xml).toMatch(/<testsuite name="claude-code b" tests="2" failures="1"/);
  // The bar is on the delta, so a delta that reaches it passes.
  const met = await compared(box, {
    checks: WEIGHTED,
    more: { minDelta: 0.2 },
  });
  expect(met.ran.status, met.ran.stderr).toBe(0);
});

test("--min-delta with score is a usage error that names run", async () => {
  const box = sandbox();
  const cases = plantCase(box, [WRITES_SUMMARY]);
  const flagged = await box.cli([
    "score",
    ...["--subject", "none", "--cases", cases, MIN_DELTA, "0"],
  ]);
  expect(flagged.status).toBe(EXIT.usage);
  expect(flagged.stderr).toContain("Unknown option '--min-delta' for score");
  expect(flagged.stderr).toContain("it applies to run, plan");
  // The config key is ignored under score, with one note.
  box.write("skill-evals.config.json", { minDelta: 0.1 });
  const configured = await box.cli([
    ...["score", "--subject", "none", "--cases", cases],
  ]);
  expect(configured.status, configured.stderr).toBe(0);
  expect(configured.stdout).toContain(
    "minDelta applies to run: the config's minDelta set one, and it was not checked.",
  );
});

test("a minDelta that is out of range, or a bad seed, is a usage error", async () => {
  const box = sandbox();
  const same = plugin(box, "plugin-same", {});
  const cases = plantCase(box, [WRITES_SUMMARY]);
  const args = ["run", "--a", same, "--b", same, "--cases", cases];
  const refused = async (flags: string[], expected: RegExp) => {
    const ran = await box.cli([...args, ...flags]);
    expect(ran.status, flags.join(" ")).toBe(EXIT.usage);
    expect(ran.stderr).toMatch(expected);
  };
  await refused([MIN_DELTA, "1.5"], /minDelta must be a number from -1 to 1/);
  await refused([MIN_DELTA, "x"], /--min-delta is not a decimal number/);
  await refused(
    ["--seed", "0"],
    /seed must be a positive integer up to 4294967295/,
  );
  await refused(["--seed", "1.5"], /seed must be a positive integer/);
  await refused(["--seed", "4294967296"], /seed must be a positive integer/);
  for (const [key, value] of [
    ["minDelta", 2],
    ["seed", 0],
  ] as const) {
    box.write("skill-evals.config.json", { [key]: value });
    const ran = await box.cli(args);
    expect(ran.status, key).toBe(EXIT.usage);
    expect(ran.stderr).toContain(`"${key}" must be`);
  }
});

test("a minDelta under score gets one note in the report, and is not checked", async () => {
  const box = sandbox();
  const cases = plantCase(box, [WRITES_SUMMARY], { minDelta: 0.5 });
  box.write("cases/other/prompt.md", "second\n");
  box.write("cases/other/case.json", {
    checks: [WRITES_SUMMARY],
    minDelta: 0.1,
  });
  const ran = await box.cli([
    ...["score", "--subject", "none", "--cases", cases, "--reps", "1"],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  const notes = ran.stdout.match(/minDelta applies to run/g) ?? [];
  expect(notes).toHaveLength(1);
  expect(ran.stdout).toContain(
    "`other`, `restate` set one, and it was not checked",
  );
  expect(ran.stdout).not.toContain("Verdict");
  expect(ran.stdout).not.toContain("95%");
});

test("a case with no valid run on one side has no delta, no verdict, and no pass", async () => {
  const box = sandbox();
  const { ran, results, out } = await compared(box, {
    checks: [WRITES_SUMMARY],
    // The ghost plugin reports another directory as loaded, so no run of B is valid.
    b: plugin(box, "plugin-ghost", { ghost: true }),
    flags: ["--report", "md,json", MIN_DELTA, "0"],
  });
  expect(ran.status).toBe(EXIT.invalid);
  expect(tableRow(ran.stdout, "restate")).toMatch(/\| n\/a \| `file_exists/);
  expect(ran.stdout).toContain("Suite delta: n/a over 0 cases");
  const [suite] = results?.comparison?.harnesses ?? [];
  expect(suite?.cases[0]).toMatchObject({
    delta: null,
    low: null,
    verdict: null,
  });
  expect(suite?.suite).toMatchObject({ delta: null, verdict: null, cases: 0 });
  const report = readJson(out, "report.json") as {
    cases: { subject: string; delta: number | null; verdict: string | null }[];
  };
  expect(report.cases.map((one) => [one.delta, one.verdict])).toEqual([
    [null, null],
    [null, null],
  ]);
  // A bar cannot be reached with no delta.
  expect(results?.belowBar.join("\n")).toContain("suite delta n/a");
});
