import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "../cases.js";
import { TEMPLATES } from "../init-templates.js";
import { sandbox } from "../testing/sandbox.js";

const USAGE_ERROR = 2;

test("every init template validates", async () => {
  const box = sandbox();
  const cases = path.join(box.root, "cases");
  for (const kind of Object.keys(TEMPLATES)) {
    const made = await box.cli([
      "init",
      kind,
      "--kind",
      kind,
      "--cases",
      cases,
    ]);
    expect(made.status, `${kind}: ${made.stderr}`).toBe(0);
    expect(made.stdout).toContain(path.join(cases, kind, "case.json"));
  }
  const checked = await box.cli([
    "validate",
    "--cases",
    cases,
    "--subject",
    "none",
  ]);
  expect(checked.status, checked.stdout).toBe(0);
  expect(checked.stdout).toContain(
    `${String(Object.keys(TEMPLATES).length)} cases, 0 problems`,
  );
  expect(
    loadCases(cases)
      .map(({ kind }) => kind)
      .sort(),
  ).toEqual(Object.keys(TEMPLATES).sort());
});

test("init writes under evals/cases by default, and a nested id makes the folders", async () => {
  const box = sandbox();
  const made = await box.cli([
    "init",
    "routing/commit-guard",
    "--kind",
    "negative",
  ]);
  expect(made.status, made.stderr).toBe(0);
  const dir = path.join(box.root, "evals/cases/routing/commit-guard");
  expect(fs.existsSync(path.join(dir, "prompt.md"))).toBe(true);
  expect(
    JSON.parse(fs.readFileSync(path.join(dir, "case.json"), "utf8")),
  ).toMatchObject({
    kind: "negative",
  });
});

test("init refuses an existing directory and leaves it as it was", async () => {
  const box = sandbox();
  box.write("evals/cases/taken/notes.txt", "mine\n");
  const made = await box.cli(["init", "taken", "--kind", "trigger"]);
  expect(made.status).toBe(USAGE_ERROR);
  expect(made.stderr).toMatch(/already exists/);
  expect(fs.readdirSync(path.join(box.root, "evals/cases/taken"))).toEqual([
    "notes.txt",
  ]);
});

test.each(["a@b", "a,b", "_shared", "a/_b", "../out", "a//b", "a b", ""])(
  "init refuses the id %j, as a case could not have it",
  async (id) => {
    const box = sandbox();
    const made = await box.cli(["init", id, "--kind", "trigger"]);
    expect(made.status).toBe(USAGE_ERROR);
    expect(fs.existsSync(path.join(box.root, "evals"))).toBe(false);
  },
);

test("init refuses an id inside another case", async () => {
  const box = sandbox();
  box.write("evals/cases/outer/prompt.md", "x\n");
  const made = await box.cli(["init", "outer/inner", "--kind", "trigger"]);
  expect(made.status).toBe(USAGE_ERROR);
  expect(made.stderr).toMatch(/inside the case outer/);
});

test.each([[[]], [["--kind", "poem"]]])(
  "init needs a known --kind: %j",
  async (flags) => {
    const box = sandbox();
    const made = await box.cli(["init", "fresh", ...flags]);
    expect(made.status).toBe(USAGE_ERROR);
    expect(made.stderr).toMatch(/--kind trigger\|negative/);
  },
);
