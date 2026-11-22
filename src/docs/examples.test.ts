import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "../cases.js";
import { CHECKS } from "../checks/index.js";
import { sandbox } from "../testing/sandbox.js";

const root = path.resolve(import.meta.dirname, "../..");
const HELLO = "Say hello.\n";
const sources = [
  path.join(root, "README.md"),
  ...fs
    .globSync("**/*.md", { cwd: path.join(root, "docs/src/content/docs") })
    .map((file) => path.join(root, "docs/src/content/docs", file)),
];

/** One fenced `json` block of a document, parsed. */
interface Example {
  /** The document and the block's place in it, for a failure message. */
  where: string;
  value: Record<string, unknown>;
}

const examples: Example[] = sources.flatMap((file) =>
  [...fs.readFileSync(file, "utf8").matchAll(/^```json\n(.*?)^```$/gms)].map(
    (block, index) => ({
      where: `${path.relative(root, file)} block ${String(index + 1)}`,
      value: JSON.parse(block[1] ?? "") as Record<string, unknown>,
    }),
  ),
);
// A block with a `type` is one check, and a block with `checks` is a whole case file. Any other block is a config file.
const isCheck = ({ value }: Example): boolean => "type" in value;
const isCase = ({ value }: Example): boolean => "checks" in value;
const cases = examples.filter((example) => isCheck(example) || isCase(example));
const configs = examples.filter(
  (example) => !isCheck(example) && !isCase(example),
);

test("the docs and the README hold examples of both kinds", () => {
  expect(cases.length).toBeGreaterThan(1);
  expect(configs.length).toBeGreaterThan(0);
});

test.each(cases)(
  "the case validation accepts the example in $where",
  (example) => {
    const box = sandbox();
    const caseFile = isCheck(example)
      ? { checks: [example.value] }
      : example.value;
    // A case with turns names its prompt files, and has no `prompt.md`.
    const turns = Array.isArray(caseFile["turns"])
      ? (caseFile["turns"] as { prompt?: string; reply?: { prompt: string } }[])
      : [];
    const files =
      turns.length === 0
        ? ["prompt.md"]
        : turns.flatMap(({ prompt, reply }) => prompt ?? reply?.prompt ?? []);
    for (const file of files) box.write(`cases/documented/${file}`, HELLO);
    box.write("cases/documented/case.json", caseFile);
    const [loaded] = loadCases(path.join(box.root, "cases"));
    expect(loaded?.checks.length).toBeGreaterThan(0);
  },
);

test.each(configs)(
  "the config file in $where is accepted",
  async ({ value }) => {
    const box = sandbox();
    box.write("skill-evals.config.json", value);
    const listed = await box.cli(["list"]);
    expect(listed.status, listed.stderr).toBe(0);
  },
);

test("an example the tool would reject fails the same validation", () => {
  const box = sandbox();
  box.write("cases/documented/prompt.md", HELLO);
  box.write("cases/documented/case.json", {
    checks: [{ type: "skill_loaded" }],
  });
  expect(() => loadCases(path.join(box.root, "cases"))).toThrow(
    /skill_loaded needs a string "skill"/,
  );
});

// A case that shows a feature and not one check type: it may have any name. A new one is added here on purpose.
const FEATURE_EXAMPLES = [
  "by-agent",
  "judge-transcript",
  "requires",
  "routing",
  "setup-git",
  "setup-home",
  "shared-fixture",
  "turns",
  "variants",
];
const examplesDir = path.join(root, "examples/cases");

test("every feature example exists, so that the list cannot go stale", () => {
  for (const name of FEATURE_EXAMPLES) {
    expect(
      fs.existsSync(path.join(examplesDir, name, "case.json")) ||
        fs.readdirSync(path.join(examplesDir, name)).length > 0,
      name,
    ).toBe(true);
  }
});

test("one example per check type", async () => {
  // A later task that adds a check type to CHECKS must add examples/cases/<check type>/ with it: this test fails until
  // it does, and fails again when a check type is removed and its example is not.
  const directories = fs
    .readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .filter((name) => name !== "hello" && !FEATURE_EXAMPLES.includes(name))
    .sort();
  expect(directories).toEqual(Object.keys(CHECKS).sort());
  for (const type of Object.keys(CHECKS)) {
    const loaded = loadCases(examplesDir, type);
    expect(
      loaded.some(({ checks }) => checks.some((check) => check.type === type)),
      `${type} is not used by its own example`,
    ).toBe(true);
  }
  const box = sandbox();
  const validated = await box.cli([
    ...["validate", "--cases", examplesDir, "--subject", "none"],
  ]);
  expect(validated.stdout).toMatch(/, 0 problems, /);
  expect(validated.status, validated.stdout).toBe(0);
});
