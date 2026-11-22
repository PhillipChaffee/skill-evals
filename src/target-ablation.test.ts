import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import type { Evaluation } from "./evaluate.js";
import { sandbox } from "./testing/sandbox.js";
import type { Sandbox } from "./testing/sandbox.js";
import { BLINDING, CASES, TARGET } from "./testing/target.js";

const CASE = "bootstrap-ablation";
const KIT = path.join(TARGET, "ablation-kit");
const SUBJECTS = [
  `full=${KIT}`,
  `no-hook=${KIT}:hooks=off`,
  `one-skill=${KIT}:skills=only:bug-fix`,
  "none=none",
].join(",");

/**
 * Runs the ablation: one invocation, four subjects.
 * @param box - The sandbox.
 * @param more - More flags of `run`.
 * @returns The command's result, and the results it wrote.
 */
async function ablate(box: Sandbox, more: string[] = []) {
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    ...["run", "--subjects", SUBJECTS, "--cases", CASES, "--case", CASE],
    ...["--reps", "5", "--out", out, "--report", "md,json", ...more],
  ]);
  const results = JSON.parse(
    fs.readFileSync(path.join(out, "results.json"), "utf8"),
  ) as Evaluation;
  return { ran, results, out };
}

test("bootstrap ablation: the prompt tells the agent nothing about being graded, and the case names both skills", () => {
  const [found] = loadCases(CASES, CASE);
  expect(found?.prompt).not.toMatch(BLINDING);
  expect(found?.targets).toEqual(["bug-fix", "triage"]);
});

test("bootstrap ablation: one invocation, four subjects, four routing rates and a verdict column", async () => {
  const box = sandbox();
  const { ran, results, out } = await ablate(box);
  expect(ran.status, ran.stderr).toBe(0);
  // The routing rate of each subject: the share of its runs in which each skill loaded, over both checks.
  const [suite] = results.suites;
  const rate = (label: string) => suite?.suite[label];
  expect(["full", "no-hook", "one-skill", "none"].map(rate)).toEqual([
    1, 0, 0.5, 0,
  ]);
  // Each checks' rate in the report's own words: the kit routes both, no hook routes neither, one skill routes one.
  expect(ran.stdout).toContain(
    "`skill_loaded bug-fix` FULL 5/5, NO-HOOK 0/5, ONE-SKILL 5/5, NONE 0/5",
  );
  expect(ran.stdout).toContain(
    "`skill_loaded triage` FULL 5/5, NO-HOOK 0/5, ONE-SKILL 0/5, NONE 0/5",
  );
  expect(ran.stdout).toContain(
    "| Case | Score, FULL / NO-HOOK / ONE-SKILL / NONE | Verdict no-hook | Verdict one-skill | Verdict none |",
  );
  // Three deltas against the full kit, each with its verdict.
  const verdicts = results.comparisons.map((found) => {
    const one = found.harnesses[0]?.cases[0];
    return [found.subject, one?.delta, one?.verdict];
  });
  expect(verdicts).toEqual([
    ["no-hook", -1, "hurt"],
    ["one-skill", -0.5, "hurt"],
    ["none", -1, "hurt"],
  ]);
  const report = JSON.parse(
    fs.readFileSync(path.join(out, "report.json"), "utf8"),
  ) as { cases: { subject: string; verdict: string | null }[] };
  expect(
    report.cases.map(({ subject, verdict }) => [subject, verdict]),
  ).toEqual([
    ["full", null],
    ["no-hook", "hurt"],
    ["one-skill", "hurt"],
    ["none", "hurt"],
  ]);
  // The hook ran only where it was left in.
  const hooks = (label: string) =>
    results.records.filter(
      (record) =>
        record.subject === label &&
        record.skillsLoaded.length === (label === "full" ? 2 : 1),
    ).length;
  expect(hooks("full")).toBe(5);
  expect(results.meta.subjects.map((one) => one.options)).toEqual([
    undefined,
    "hooks=off",
    "skills=only:bug-fix",
    undefined,
  ]);
  // The kit in the repository is as it was.
  expect(fs.existsSync(path.join(KIT, "hooks/hooks.json"))).toBe(true);
  expect(fs.existsSync(path.join(KIT, "skills/triage/SKILL.md"))).toBe(true);
});

test("bootstrap ablation: a noise file says which deltas clear the noise floor", async () => {
  const box = sandbox();
  const noise = box.write("noise.json", {
    schemaVersion: 1,
    harness: "claude-code",
    reps: 5,
    seed: 1,
    caseIds: [CASE],
    perCase: { [CASE]: { sd: 0, maxAbsDelta: 0.6, p95AbsDelta: 0.6 } },
    perCheckType: { skill_loaded: { sd: 0 } },
    suite: { sd: 0, p95AbsDelta: 0.6 },
  });
  const { ran, results } = await ablate(box, ["--noise", noise]);
  expect(ran.status, ran.stderr).toBe(0);
  // Losing one skill moves the rate by 0.5, inside the noise of 0.6; losing the hook or the kit moves it by 1.
  expect(
    results.comparisons.map((found) => found.harnesses[0]?.cases[0]?.verdict),
  ).toEqual(["hurt", "within noise", "hurt"]);
  expect(ran.stdout).toContain("Noise file:");
});
