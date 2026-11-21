import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadCases } from "../cases.js";
import { skillsFolder } from "../testing/plant.js";
import { sandbox } from "../testing/sandbox.js";
import type { Sandbox } from "../testing/sandbox.js";
import type { Case } from "../cases.js";
import type { Lint, LintContext } from "./validate.js";
import { LINTS } from "./validate.js";

const USAGE_ERROR = 2;
const fine = { type: "file_exists", path: "notes.txt" };

/**
 * Plants a skills folder with one skill.
 * @param box - The sandbox, whose root holds the cases.
 * @returns The flags that point `validate` at the folder and at the cases.
 */
function flags(box: Sandbox): string[] {
  const subject = skillsFolder(box, "skills", { alpha: "# alpha\n" });
  return ["--subject", subject, "--cases", `${box.root}/cases`];
}

/**
 * Writes one case.
 * @param box - The sandbox.
 * @param id - The case's directory below `cases`.
 * @param file - What `case.json` holds.
 */
function plant(box: Sandbox, id: string, file: unknown): void {
  box.write(`cases/${id}/prompt.md`, "say it\n");
  box.write(`cases/${id}/case.json`, file);
}

test("validate exits 2 and names every bad case, not only the first", async () => {
  const box = sandbox();
  plant(box, "good", { checks: [fine] });
  plant(box, "bad/regex", {
    checks: [{ type: "file_matches", path: "a", pattern: "(" }],
  });
  plant(box, "bad/key", { checks: [fine], colour: 1 });
  plant(box, "bad/tag", { checks: [fine], tags: ["Not A Tag"] });
  const result = await box.cli(["validate", ...flags(box)]);
  expect(result.status).toBe(USAGE_ERROR);
  const lines = result.stdout.trim().split("\n");
  expect(lines).toHaveLength(4);
  expect(lines[0]).toMatch(/^problem bad\/key: .*unknown key "colour"/);
  expect(lines[1]).toMatch(/^problem bad\/regex: /);
  expect(lines[2]).toMatch(/^problem bad\/tag: /);
  expect(lines[3]).toBe("1 cases, 3 problems, 0 warnings");
});

test("validate spends nothing: no harness is started", async () => {
  const box = sandbox();
  plant(box, "good", { checks: [fine] });
  plant(box, "bad", { checks: [] });
  const result = await box.cli(["validate", ...flags(box)]);
  expect(result.status).toBe(USAGE_ERROR);
  expect(fs.existsSync(box.started)).toBe(false);
  const clean = sandbox();
  plant(clean, "good", { checks: [fine] });
  expect((await clean.cli(["validate", ...flags(clean)])).status).toBe(0);
  expect(fs.existsSync(clean.started)).toBe(false);
});

test("validate warns when targets or a check names a skill the subject lacks, except skill_not_loaded", async () => {
  const box = sandbox();
  plant(box, "route", {
    targets: ["alpha", "ghost"],
    checks: [
      { type: "skill_loaded", skill: "phantom" },
      { type: "skill_loaded", skill: "alpha" },
      { type: "skill_not_loaded", skill: "absent" },
    ],
  });
  const result = await box.cli(["validate", ...flags(box)]);
  expect(result.status).toBe(0);
  const lines = result.stdout.trim().split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/^warning route: targets names "ghost"/);
  expect(lines[1]).toMatch(/^warning route: .*skill_loaded.*"phantom"/);
  expect(lines[2]).toBe("1 cases, 0 problems, 2 warnings");
});

test("validate warns about the cases an installed harness would not run, with what is missing", async () => {
  const box = sandbox();
  plant(box, "needs-tool", {
    requires: ["bin:no-such-tool-for-validate"],
    checks: [fine],
  });
  const result = await box.cli(["validate", ...flags(box)]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    "warning needs-tool: not applicable on claude-code: needs bin:no-such-tool-for-validate",
  );
});

test("under --subject none, one line says that skill names were not checked", async () => {
  const box = sandbox();
  plant(box, "a", { targets: ["ghost"], checks: [fine] });
  plant(box, "b", { targets: ["ghost"], checks: [fine] });
  const cases = `${box.root}/cases`;
  const result = await box.cli([
    "validate",
    "--subject",
    "none",
    "--cases",
    cases,
  ]);
  expect(result.status).toBe(0);
  const lines = result.stdout.trim().split("\n");
  expect(lines).toEqual([
    `warning ${cases}: the subject is none, so skill names were not checked`,
    "2 cases, 0 problems, 1 warnings",
  ]);
});

test("--lenient turns an unknown key into a warning that names the case", async () => {
  const box = sandbox();
  plant(box, "typo", { checks: [fine], colour: 1 });
  const strict = await box.cli(["validate", ...flags(box)]);
  expect(strict.status).toBe(USAGE_ERROR);
  const lenient = await box.cli(["validate", ...flags(box), "--lenient"]);
  expect(lenient.status).toBe(0);
  expect(lenient.stdout).toMatch(
    /^warning typo: .*ignored unknown key "colour"/m,
  );
  expect(lenient.stdout).toMatch(/^1 cases, 0 problems, 1 warnings$/m);
});

test("the selection flags limit what validate loads", async () => {
  const box = sandbox();
  plant(box, "good", { checks: [fine], tags: ["keep"] });
  plant(box, "bad", { checks: [] });
  const only = await box.cli(["validate", ...flags(box), "--case", "good"]);
  expect(only.status).toBe(0);
  expect(only.stdout.trim()).toBe("1 cases, 0 problems, 0 warnings");
  // A tag is known only once a case is read, so a bad case is still reported unless an id glob rules it out.
  const tagged = await box.cli(["validate", ...flags(box), "--tag", "keep"]);
  expect(tagged.status).toBe(USAGE_ERROR);
  const ruledOut = await box.cli([
    "validate",
    ...flags(box),
    "--tag",
    "keep",
    "--not-case",
    "bad",
  ]);
  expect(ruledOut.status).toBe(0);
  const none = await box.cli(["validate", ...flags(box), "--case", "zzz"]);
  expect(none.status).toBe(USAGE_ERROR);
  expect(none.stderr).toMatch(/no case in .* matches "zzz"/);
});

test("a directory name with @ and a missing cases directory are problems, not crashes", async () => {
  const box = sandbox();
  plant(box, "bad@name", { checks: [fine] });
  plant(box, "good", { checks: [fine] });
  const result = await box.cli(["validate", ...flags(box)]);
  expect(result.status).toBe(USAGE_ERROR);
  expect(result.stdout).toMatch(/^problem bad@name: .*may not hold "@"/m);
  const missing = await box.cli([
    "validate",
    "--subject",
    "none",
    "--cases",
    `${box.root}/nowhere`,
  ]);
  expect(missing.status).toBe(USAGE_ERROR);
  expect(missing.stdout).toMatch(/^problem .*nowhere: cannot read the cases/m);
});

test("a later task adds a lint by appending to LINTS, and problems print before warnings", async () => {
  const box = sandbox();
  plant(box, "good", { checks: [fine] });
  const extra = (cases: Case[], context: LintContext): Lint[] => [
    {
      level: "warning",
      caseId: "good",
      text: `first of ${String(cases.length)} in ${path.basename(context.casesDir)}`,
    },
    { level: "problem", caseId: "good", text: "second" },
  ];
  LINTS.push(extra);
  afterEach(() => {
    LINTS.splice(LINTS.indexOf(extra), 1);
  });
  const result = await box.cli(["validate", ...flags(box)]);
  expect(result.status).toBe(USAGE_ERROR);
  expect(result.stdout.trim().split("\n")).toEqual([
    "problem good: second",
    "warning good: first of 1 in cases",
    "1 cases, 1 problems, 1 warnings",
  ]);
});

test("loadCases with onError records each bad case and skips it; without it the first one throws", () => {
  const box = sandbox();
  plant(box, "good", { checks: [fine] });
  plant(box, "bad1", { checks: [] });
  plant(box, "bad2", { checks: [], colour: 1 });
  const seen: string[] = [];
  const cases = loadCases(`${box.root}/cases`, "**", {
    onError: (id) => seen.push(id),
  });
  expect(cases.map((one) => one.id)).toEqual(["good"]);
  expect(seen.sort()).toEqual(["bad1", "bad2"]);
  expect(() => loadCases(`${box.root}/cases`)).toThrow(/non-empty array/);
});
