import { expect, test } from "vitest";
import { EXIT } from "./exit-codes.js";
import { sandbox, tableRow } from "./testing/sandbox.js";
import {
  LOADS_BRO,
  WRITES_SUMMARY,
  compared,
  readJson,
} from "./testing/delta.js";
import { plugin } from "./testing/plant.js";

const TOO_FEW = "too few runs";
const WEIGHTED = [
  { ...LOADS_BRO, weight: 2 },
  { ...WRITES_SUMMARY, weight: 8 },
];

test("a case with fewer than 5 valid runs on a side is too few runs, and shows n for each side", async () => {
  const box = sandbox();
  const four = await compared(box, { checks: WEIGHTED, reps: 4 });
  expect(tableRow(four.ran.stdout, "restate")).toContain(
    "| too few runs (A n=4, B n=4) |",
  );
  const [one] = four.results?.comparison?.harnesses[0]?.cases ?? [];
  expect(one?.verdict).toBe(TOO_FEW);
  expect(one?.delta).toBeCloseTo(0.2, 10);
  const five = await compared(box, { checks: WEIGHTED, reps: 5 });
  expect(tableRow(five.ran.stdout, "restate")).toContain(
    "| helped (+0.20, 95% +0.20..+0.20) |",
  );
});

test("the suite needs 5 valid runs on each side of every case, like a case does, and says how few it has", async () => {
  const box = sandbox();
  const four = await compared(box, { checks: WEIGHTED, reps: 4 });
  expect(four.ran.stdout).toContain(
    "Suite delta: too few runs (fewest on a side: n=4) over 1 case",
  );
  const five = await compared(box, { checks: WEIGHTED, reps: 5 });
  expect(five.ran.stdout).toContain(
    "Suite delta: helped (+0.20, 95% +0.20..+0.20) over 1 case",
  );
});

test("the footnote prints the constant and says that percentile intervals under-cover", async () => {
  const box = sandbox();
  const { ran } = await compared(box, { checks: WEIGHTED, reps: 1 });
  expect(ran.stdout).toContain(
    "at least 5 valid runs on each side (MIN_RUNS_FOR_VERDICT)",
  );
  expect(ran.stdout).toContain("Percentile intervals under-cover at small n");
});

test("bars and exit codes ignore the run count", async () => {
  const box = sandbox();
  const same = plugin(box, "plugin-same", {});
  const missed = await compared(box, {
    checks: [WRITES_SUMMARY],
    a: same,
    b: same,
    reps: 1,
    flags: ["--min-delta", "0.1"],
  });
  expect(missed.ran.status).toBe(EXIT.bar);
  const met = await compared(box, {
    checks: WEIGHTED,
    reps: 1,
    flags: ["--min-delta", "0.1"],
  });
  expect(met.ran.status, met.ran.stderr).toBe(0);
});

test("a case with too few runs cannot be discriminating, and report.json says too few runs", async () => {
  const box = sandbox();
  const { ran, out } = await compared(box, {
    checks: [LOADS_BRO],
    a: "none",
    reps: 4,
    flags: ["--report", "md,json"],
  });
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("| restate | 0.00 | 1.00 | no evidence |");
  const report = readJson(out, "report.json") as {
    cases: { verdict: string; discrimination: string }[];
  };
  expect(report.cases.map((one) => [one.verdict, one.discrimination])).toEqual([
    [TOO_FEW, "no evidence"],
    [TOO_FEW, "no evidence"],
  ]);
});

test("with B none the footnote says that hurt means A scored higher", async () => {
  const box = sandbox();
  const loader = plugin(box, "plugin-loader", { skill: "bro" });
  const { ran } = await compared(box, {
    checks: [LOADS_BRO],
    a: loader,
    b: "none",
  });
  expect(ran.stdout).toContain(
    "Verdicts are B minus A; with B none, hurt means A scored higher.",
  );
  expect(tableRow(ran.stdout, "restate")).toContain("hurt (−1.00");
  const other = await compared(box, {
    checks: [LOADS_BRO],
    a: "none",
    b: loader,
  });
  expect(other.ran.stdout).not.toContain("hurt means A scored higher");
});
