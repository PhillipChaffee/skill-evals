import fs from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { idProblem, nameProblem } from "../case-id.js";
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

test.each([
  "a@b",
  "a,b",
  "_shared",
  "a/_b",
  "../out",
  "a//b",
  "a\0b",
  "a\u001bb",
  "a\u007fb",
  "x".repeat(256),
  "",
])("init refuses the id %j, as a case could not have it", async (id) => {
  const box = sandbox();
  const made = await box.cli(["init", id, "--kind", "trigger"]);
  expect(made.status).toBe(USAGE_ERROR);
  expect(fs.existsSync(path.join(box.root, "evals"))).toBe(false);
});

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

test("init accepts a name that discovery accepts: a space, a dot, 255 bytes", async () => {
  const box = sandbox();
  for (const id of ["a b", "v1.2", "x".repeat(255), "é".repeat(127)]) {
    const made = await box.cli(["init", id, "--kind", "trigger"]);
    expect(made.status, `${id}: ${made.stderr}`).toBe(0);
  }
  expect(loadCases(path.join(box.root, "evals/cases"))).toHaveLength(4);
});

test("init under a folder that is a file exits 2, with no stack", async () => {
  const box = sandbox();
  box.write("evals/cases/afile", "text\n");
  const made = await box.cli(["init", "afile/sub", "--kind", "trigger"]);
  expect(made.status).toBe(USAGE_ERROR);
  expect(made.stderr).toMatch(/cannot create/);
  expect(made.stderr).not.toMatch(/\n\s+at /);
});

test("init echoes no control character of a refused id", async () => {
  const box = sandbox();
  const made = await box.cli(["init", "a\u001b[31mb", "--kind", "trigger"]);
  expect(made.status).toBe(USAGE_ERROR);
  // eslint-disable-next-line no-control-regex
  expect(made.stderr).not.toMatch(/\u001b/);
});

test("init leaves no half-made directory when a write fails", async () => {
  const box = sandbox();
  const real = fs.writeFileSync;
  let writes = 0;
  const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
    writes += 1;
    if (writes === 2) throw new Error("disk full");
    real(...args);
  });
  const made = await box.cli(["init", "half", "--kind", "trigger"]);
  spy.mockRestore();
  expect(made.status).toBe(USAGE_ERROR);
  expect(made.stderr).toMatch(/disk full/);
  expect(fs.existsSync(path.join(box.root, "evals/cases/half"))).toBe(false);
  expect(fs.existsSync(path.join(box.root, "evals/cases"))).toBe(true);
});

test("a case directory name with a control character is a load error, as init says", async () => {
  const box = sandbox();
  for (const name of ["a\u001bb"]) {
    box.write(`cases/${name}/prompt.md`, "x\n");
    box.write(`cases/${name}/case.json`, {
      checks: [{ type: "output_contains", text: "x" }],
    });
  }
  const validated = await box.cli([
    "validate",
    "--cases",
    path.join(box.root, "cases"),
    "--subject",
    "none",
  ]);
  expect(validated.status).toBe(USAGE_ERROR);
  expect(validated.stdout).toMatch(/control character/);
});

test("the id rule names a part over 255 bytes, which no directory can have", () => {
  expect(nameProblem("y".repeat(256))).toMatch(/over 255 bytes/);
  expect(nameProblem("y".repeat(255))).toBeNull();
  expect(idProblem("ok/" + "é".repeat(128))).toMatch(/over 255 bytes/);
});
