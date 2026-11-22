import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { plantCase } from "./testing/plant.js";
import { readResults, sandbox } from "./testing/sandbox.js";
import { startsOf } from "./testing/suite.js";
import { BRO_LOADED, compared, ruggedKit } from "./testing/variants.js";

const TWO = "x=none,y=none";
const LABELS = ["full", "lean", "one", "none"];
const FORMATS = ["--report", "md,json,junit,html"];

/**
 * Plants the case and the kit, and runs the four subjects of the first test in one invocation.
 * @returns The command's result, and the results it wrote.
 */
async function fourWays() {
  const box = sandbox();
  const kit = ruggedKit(box);
  plantCase(box, [BRO_LOADED]);
  const subjects = `full=${kit},lean=${kit}:hooks=off,one=${kit}:skills=only:bro,none=none`;
  const { ran, out } = await compared(box, subjects, FORMATS);
  return { ran, out, results: readResults(out) };
}

test("four subjects give one report with three deltas", async () => {
  const { ran, results } = await fourWays();
  expect(ran.status, ran.stderr).toBe(0);
  expect(results.subjects.map((one) => one.label)).toEqual(LABELS);
  // Three subjects after the baseline, each with a delta, an interval and a verdict against `full`.
  expect(
    results.comparisons.map(({ subject, baseline }) => [subject, baseline]),
  ).toEqual([
    ["lean", "full"],
    ["one", "full"],
    ["none", "full"],
  ]);
  const [lean, one, none] = results.comparisons.map(
    (found) => found.harnesses[0]?.cases[0],
  );
  expect([lean?.delta, one?.delta, none?.delta]).toEqual([0, 0, -1]);
  expect([lean?.verdict, one?.verdict, none?.verdict]).toEqual([
    "within noise",
    "within noise",
    "hurt",
  ]);
  // The discrimination of each subject is taken against the none subject: the kit beats it, whichever way it is read.
  expect([lean, one, none].map((found) => found?.discrimination)).toEqual([
    "discriminating",
    "discriminating",
    "discriminating",
  ]);
  // Bars apply to the last subject, which is none here, and no bar was set.
  expect(results.barSubject).toBe("none");
  expect(results.comparison?.harnesses).toEqual(
    results.comparisons[2]?.harnesses,
  );
  expect(results.meta.subjects.map((each) => each.options)).toEqual([
    undefined,
    "hooks=off",
    "skills=only:bro",
    undefined,
  ]);
});

test("the four-subject report has a verdict column for each subject after the baseline, in every format", async () => {
  const { ran, out } = await fourWays();
  expect(ran.stdout).toContain("# Skill comparison");
  expect(ran.stdout).toContain("Score, FULL / LEAN / ONE / NONE");
  expect(ran.stdout).toContain("| Case | Subject arm | None | Subject |");
  expect(ran.stdout).toContain(", with hooks=off");
  for (const name of ["lean", "one", "none"]) {
    expect(ran.stdout).toContain(`Verdict ${name}`);
    expect(ran.stdout).toContain(`Suite delta ${name} against full`);
  }
  const read = (file: string) => fs.readFileSync(path.join(out, file), "utf8");
  const json = JSON.parse(read("report.json")) as {
    cases: { subject: string; verdict: string | null }[];
  };
  const summary = JSON.parse(read("summary.json")) as {
    suites: { label: string }[];
  };
  for (const label of LABELS) {
    expect(read("report.html")).toContain(`<td>${label}</td>`);
    expect(read("report.xml")).toContain(`name="claude-code ${label}"`);
    expect(json.cases.some((row) => row.subject === label)).toBe(true);
  }
  const verdictOf = (label: string) =>
    json.cases.find((row) => row.subject === label)?.verdict;
  expect([verdictOf("full"), verdictOf("none")]).toEqual([null, "hurt"]);
  expect(summary.suites.map((row) => row.label)).toEqual(LABELS);
});

test("duplicate labels are a usage error", async () => {
  const box = sandbox();
  plantCase(box, [BRO_LOADED]);
  const twice = await compared(box, "x=none,x=none");
  expect(twice.ran.status).toBe(2);
  expect(twice.ran.stderr).toContain('duplicate subject label "x"');
  // Nothing ran.
  expect(startsOf(box)).toBe(0);
});

test.each([
  ["x=none", /takes 2 to 8 subjects, not 1/],
  [
    "a=none,b=none,c=none,d=none,e=none,f=none,g=none,h=none,i=none",
    /takes 2 to 8 subjects, not 9/,
  ],
  ["X=none,y=none", /lowercase letters, digits and hyphens/],
  ["1x=none,y=none", /starting with a letter/],
  ["hooks=none,y=none", /name of a subject option/],
  ["x=none,y", /"y" is not one/],
  ["x=none,y=", /"y=" is not one/],
  ["x=none,y=none:hooks=on", /unknown subject option "hooks=on"/],
])("--subjects %s is a usage error", async (subjects, why) => {
  const box = sandbox();
  plantCase(box, [BRO_LOADED]);
  const { ran } = await compared(box, subjects);
  expect(ran.status, ran.stderr).toBe(2);
  expect(ran.stderr).toMatch(why);
});

test("--subjects cannot be combined with --a, --b or --subject", async () => {
  const box = sandbox();
  plantCase(box, [BRO_LOADED]);
  const withA = await compared(box, TWO, ["--a", "none"]);
  expect(withA.ran.status).toBe(2);
  expect(withA.ran.stderr).toContain("cannot be combined with --a, --b");
  const plan = await box.cli([
    ...["plan", "--subjects", TWO, "--subject", "none"],
    ...["--cases", path.join(box.root, "cases")],
  ]);
  expect(plan.status).toBe(2);
  expect(plan.stderr).toContain(
    "cannot be combined with --a, --b or --subject",
  );
});

test("a label equal to a variant id is a usage error", async () => {
  const box = sandbox();
  const variants = [{ id: "terse", promptAppend: "Be brief." }];
  plantCase(box, [BRO_LOADED], { variants });
  const { ran } = await compared(box, "terse=none,y=none");
  expect(ran.status).toBe(2);
  expect(ran.stderr).toContain(
    'subject label "terse" is also the id of a variant of the case restate',
  );
  const fine = await compared(box, TWO);
  expect(fine.ran.status, fine.ran.stderr).toBe(0);
});

test("a 0.0.1 two-subject results.json shape is unchanged for a and b", async () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  plantCase(box, [BRO_LOADED]);
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    ...["run", "--a", "none", "--b", kit, "--reps", "5", "--out", out],
    ...["--cases", path.join(box.root, "cases")],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  const results = readResults(out);
  // Every key of 0.0.1 is there; the new ones are `barSubject` and `comparisons`, added beside them.
  expect(Object.keys(results).sort()).toEqual(
    [
      ...["schemaVersion", "minScore", "minDelta", "seed", "noiseFile"],
      ...["noiseMeta", "minDeltaIgnored", "maxInvalid", "meta", "subjects"],
      ...["harnesses", "harnessReason", "model", "judge", "decisionModel"],
      ...["reps", "caseMeta", "suites", "comparison", "belowBar"],
      ...["notApplicable", "skippedChecks", "commonSet", "invalid"],
      ...["sourceChanged", "partial", "notRun", "records"],
      ...["barSubject", "comparisons"],
    ].sort(),
  );
  const subjectKeys = ["commit", "dir", "kind", "label", "skills", "spec"];
  expect(results.subjects.map((one) => Object.keys(one).sort())).toEqual([
    subjectKeys,
    subjectKeys,
  ]);
  expect(results.subjects.map(({ label }) => label)).toEqual(["a", "b"]);
  expect(Object.keys(results.suites[0]?.suite ?? {})).toEqual(["a", "b"]);
  expect(Object.keys(results.suites[0]?.cases[0]?.scores ?? {})).toEqual([
    "a",
    "b",
  ]);
  expect(new Set(results.records.map((record) => record.subject))).toEqual(
    new Set(["a", "b"]),
  );
  // A record, and the meta of a subject, have no `options` key when the subject has none.
  expect(results.records.some((record) => "options" in record)).toBe(false);
  const metaKeys = ["dirty", "label", "revision"];
  expect(results.meta.subjects.map((one) => Object.keys(one).sort())).toEqual([
    metaKeys,
    metaKeys,
  ]);
});

test("a 0.0.1 two-subject comparison is B against A as it was, and `comparisons` holds the same entry", async () => {
  const box = sandbox();
  const kit = ruggedKit(box);
  plantCase(box, [BRO_LOADED]);
  const { ran, out } = await compared(box, `a=none,b=${kit}`);
  expect(ran.status, ran.stderr).toBe(0);
  const { comparison, comparisons, barSubject } = readResults(out);
  expect(Object.keys(comparison ?? {})).toEqual(["harnesses"]);
  const [harness] = comparison?.harnesses ?? [];
  expect(Object.keys(harness?.cases[0] ?? {}).sort()).toEqual(
    [
      ...["a", "b", "delta", "discrimination", "guard", "high", "id", "low"],
      ...["minDelta", "n", "noise", "verdict"],
    ].sort(),
  );
  expect(harness?.cases[0]).toMatchObject({
    n: { a: 5, b: 5 },
    a: 0,
    b: 1,
    delta: 1,
    verdict: "helped",
    discrimination: "discriminating",
  });
  expect(comparisons).toEqual([{ subject: "b", baseline: "a", ...comparison }]);
  expect(barSubject).toBe("b");
});
