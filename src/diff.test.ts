import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { diffResults } from "./diff.js";
import { renderDiff } from "./diff-render.js";
import { EXIT } from "./exit-codes.js";
import type { Results } from "./evaluate.js";
import type { RunRecord } from "./run.js";
import { plugin } from "./testing/plant.js";
import { onlyRecord, resultsIn, scoredWith } from "./testing/rejudge.js";

const CONTAINS = { type: "output_contains", text: "fixed" };

const WARNINGS = "## Warnings";
const FIXED_NOW = "It is fixed now.";

/**
 * Scores the planted case twice, once with each answer.
 * @param answers - What the agent says in the first and in the second run.
 * @param flags - The flags of `score` for the first and for the second run.
 * @returns The sandbox and the two output directories.
 */
async function twice(
  answers: [string, string],
  flags: [string[], string[]] = [[], []],
) {
  const first = await scoredWith([CONTAINS], {
    answer: answers[0],
    flags: flags[0],
  });
  const other = plugin(first.box, "plugin-other", { answer: answers[1] });
  const b = path.join(first.box.root, "second");
  const ran = await first.box.cli([
    ...["score", "--subject", other, "--cases", first.cases],
    ...["--reps", "1", "--out", b, ...flags[1]],
  ]);
  expect(fs.existsSync(path.join(b, "results.json")), ran.stderr).toBe(true);
  return { box: first.box, a: first.out, b };
}

test("diff lists a newly failing check", async () => {
  const { box, a, b } = await twice([FIXED_NOW, "It is broken."]);
  const ran = await box.cli(["diff", a, b]);
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  expect(ran.stdout).toContain("newly failing: restate: `output_contains");
  expect(ran.stdout).toContain("1.00 -> 0.00");
  expect(ran.stdout).toContain("| restate | 1.00 (1/1) | 0.00 (1/1) | -1.00 |");
  expect(ran.stdout).not.toContain(WARNINGS);
  const back = await box.cli(["diff", path.join(b, "results.json"), a]);
  expect(back.stdout).toContain("newly passing: restate");
});

test("diff warns when the model differs and --strict exits 2", async () => {
  const { box, a, b } = await twice(
    [FIXED_NOW, FIXED_NOW],
    [
      ["--model", "small"],
      ["--model", "large"],
    ],
  );
  const plain = await box.cli(["diff", a, b]);
  expect(plain.status).toBe(EXIT.ok);
  expect(plain.stdout).toContain(WARNINGS);
  expect(plain.stdout).toContain("the agent model differs: A small; B large");
  expect(plain.stdout.indexOf(WARNINGS)).toBeLessThan(
    plain.stdout.indexOf("## Totals"),
  );
  const strict = await box.cli(["diff", a, b, "--strict"]);
  expect(strict.status).toBe(EXIT.usage);
  expect(strict.stderr).toContain("--strict");
  const same = await box.cli(["diff", a, a, "--strict"]);
  expect(same.status).toBe(EXIT.ok);
});

test("diff takes two results and refuses what is not one", async () => {
  const { box, a } = await twice(["x", "y"]);
  const one = await box.cli(["diff", a]);
  expect(one.status).toBe(EXIT.usage);
  const missing = await box.cli(["diff", a, path.join(box.root, "nowhere")]);
  expect(missing.status).toBe(EXIT.usage);
  expect(missing.stderr).toContain("cannot read the results");
  box.write("odd/results.json", { schemaVersion: 2 });
  const odd = await box.cli(["diff", a, path.join(box.root, "odd")]);
  expect(odd.status).toBe(EXIT.usage);
  expect(odd.stderr).toContain("not the results of skill-evals");
});

/**
 * Makes one check result of a synthetic record.
 * @param score - What the check scored; null for no score.
 * @returns A check result for the synthetic record.
 */
const result = (score: number | null) => ({
  type: "output_contains",
  text: "x",
  weight: 1,
  score,
});

/**
 * Makes a synthetic record of the case `c` on the harness `h`.
 * @param checks - The score of each check.
 * @param more - Fields to set besides.
 * @returns A run record with those checks.
 */
function record(
  checks: (number | null)[],
  more: Partial<RunRecord> = {},
): RunRecord {
  const scores = checks.filter((one) => one !== null);
  return {
    harness: "h",
    subject: "subject",
    caseId: "c",
    rep: 1,
    ok: true,
    error: null,
    finalText: "",
    isolated: false,
    unexpected: [],
    reportMissing: false,
    subjectLoaded: null,
    judgeProblem: null,
    checks: checks.map(result),
    score: scores.length === checks.length ? 0.5 : null,
    durationMs: 1000,
    tokens: null,
    costUsd: 0.5,
    judge: null,
    decision: null,
    ...more,
  } as unknown as RunRecord;
}

/**
 * Makes synthetic results of the harness `h`.
 * @param records - The runs; the cases are the ones they name.
 * @param more - Fields to set besides.
 * @returns Results with those runs.
 */
function results(records: RunRecord[], more: Partial<Results> = {}): Results {
  const ids = [...new Set(records.map((one) => one.caseId))];
  return {
    schemaVersion: 1,
    subjects: [{ label: "subject" }],
    harnesses: ["h"],
    meta: {
      toolVersion: "1",
      harnessVersions: {},
      models: { agent: "m", judge: null, decision: null },
      subjects: [],
      caseHashes: {
        h: Object.fromEntries(ids.map((id) => [id, `hash-${id}`])),
      },
      isolated: false,
    },
    suites: [
      {
        harness: "h",
        suite: { subject: 0.5 },
        cases: ids.map((id) => ({
          id,
          weight: 1,
          scores: { subject: 0.5 },
          runs: { subject: { valid: 1, planned: 1 } },
        })),
      },
    ],
    records,
    ...more,
  } as unknown as Results;
}

test("diff matches duplicate descriptions by position", () => {
  // Two checks with one description: the first passed and still does, the second passed and now fails.
  const a = results([record([1, 1])]);
  const b = results([record([1, 0])]);
  const [one] = diffResults(a, b).cases;
  expect(one?.newlyFailing).toHaveLength(1);
  expect(one?.newlyFailing[0]).toMatchObject({ from: 1, to: 0 });
  expect(one?.newlyPassing).toEqual([]);
  // Matched by position, the first of b pairs with the first of a, and so does the second with the second.
  const swapped = diffResults(
    results([record([0, 1])]),
    results([record([1, 0])]),
  ).cases[0];
  expect(swapped?.newlyFailing).toHaveLength(1);
  expect(swapped?.newlyPassing).toHaveLength(1);
});

test("a check passes at a mean of 0.5 over the valid runs, and invalid runs do not count", () => {
  const a = results([record([1], { rep: 1 }), record([0], { rep: 2 })]);
  const b = results([
    record([0], { rep: 1 }),
    record([0], { rep: 2 }),
    record([1], { rep: 3, error: "boom" }),
  ]);
  const [one] = diffResults(a, b).cases;
  expect(one?.newlyFailing).toHaveLength(1);
  expect(one?.newlyFailing[0]).toMatchObject({ from: 0.5, to: 0 });
});

test("diff warns about a missing meta, other harnesses, tool versions and case hashes", () => {
  const base = results([record([1])]);
  const noMeta = { ...base, meta: undefined } as unknown as Results;
  expect(diffResults(noMeta, base).warnings).toEqual([
    "A has no meta, so its models, versions and case hashes cannot be compared",
  ]);
  expect(diffResults(noMeta, noMeta).warnings).toHaveLength(2);
  const other = results([record([1], { caseId: "d" })], {
    harnesses: ["h", "g"],
    meta: {
      ...base.meta,
      toolVersion: "2",
      caseHashes: { h: { d: "hash-d" } },
    },
  });
  const warnings = diffResults(base, other).warnings.join("\n");
  expect(warnings).toContain("the harnesses differ: A h; B h, g");
  expect(warnings).toContain("the tool version differs: A 1; B 2");
  expect(warnings).toContain(
    "the case changed (its hash differs) in: h c, h d",
  );
  const judged = results([record([1])], {
    meta: { ...base.meta, models: { agent: "m", judge: "j", decision: "d" } },
  });
  expect(diffResults(base, judged).warnings.join("\n")).toContain(
    "the judge model differs: A unset; B j",
  );
});

test("diff shows a case on one side only, no valid run, and the change in cost and time", () => {
  const a = results([record([1]), record([1], { caseId: "gone" })]);
  const b = results([
    record([null], { score: null, costUsd: null, durationMs: 4000 }),
    record([1], { caseId: "new", costUsd: 1.5 }),
  ]);
  const found = diffResults(a, b);
  const byId = Object.fromEntries(found.cases.map((one) => [one.caseId, one]));
  expect(byId["gone"]?.b).toBeNull();
  expect(byId["new"]?.a).toBeNull();
  expect(byId["c"]?.newlyFailing).toEqual([]);
  expect(found.totals.a.costUsd).toBe(1);
  expect(found.totals.b).toMatchObject({
    runs: 2,
    costUsd: 1.5,
    durationMs: 5000,
  });
});

test("the diff of results with no cost says n/a", async () => {
  const { box, a } = await twice(["x", "y"]);
  const stored = resultsIn(a);
  for (const one of stored.records) one.costUsd = null;
  box.write("nocost/results.json", { ...stored, suites: stored.suites });
  const ran = await box.cli(["diff", path.join(box.root, "nocost"), a]);
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  expect(ran.stdout).toMatch(/\| Cost \| .* \| n\/a \|/);
  expect(onlyRecord(a).costUsd).toBeDefined();
});

test("a label that a suite does not score reads as no score, and a missing hash set as empty", () => {
  const base = results([record([1])]);
  const bare = results([record([1])], {
    suites: [
      {
        harness: "h",
        suite: {},
        cases: [{ id: "c", weight: 1, scores: {}, runs: {} }],
      },
    ],
    meta: {
      ...base.meta,
      models: { agent: null, judge: null, decision: "d" },
      caseHashes: { other: { c: "x" } },
    },
  } as unknown as Partial<Results>);
  const found = diffResults(bare, base);
  expect(found.cases[0]?.a).toMatchObject({
    score: null,
    runs: { valid: 0, planned: 0 },
  });
  expect(found.warnings.join("\n")).toContain(
    "the agent model differs: A unset; B m",
  );
  expect(found.warnings.join("\n")).toContain("the decision model differs");
  expect(found.warnings.join("\n")).toContain("other c, h c");
});

test("a diff with a case on one side only and no cost renders absent and n/a", () => {
  const a = results([record([1], { costUsd: null })]);
  const b = results([record([1], { caseId: "d", costUsd: null })]);
  const text = renderDiff(diffResults(a, b), { a: "a", b: "b" });
  expect(text).toContain("| c | 0.50 (1/1) | absent | n/a | n/a | n/a |");
  expect(text).toContain("| d | absent | 0.50 (1/1) | n/a | n/a | n/a |");
  expect(text).toContain("| Cost | n/a | n/a | n/a |");
});
