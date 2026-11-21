import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "../cases.js";
import { sandbox } from "../testing/sandbox.js";

const root = path.resolve(import.meta.dirname, "../..");
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
    box.write("cases/documented/prompt.md", "Say hello.\n");
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
  box.write("cases/documented/prompt.md", "Say hello.\n");
  box.write("cases/documented/case.json", {
    checks: [{ type: "skill_loaded" }],
  });
  expect(() => loadCases(path.join(box.root, "cases"))).toThrow(
    /skill_loaded needs a string "skill"/,
  );
});
