import path from "node:path";
import { format } from "prettier";
import { expect, test } from "vitest";
import { CASE_KEYS } from "../cases.js";
import { FIELDS } from "../checks/fields.js";
import { CHECKS } from "../checks/index.js";
import { COMMANDS } from "../cli.js";
import { HARNESSES } from "../harnesses/index.js";
import { CONFIG_KEYS } from "../project.js";
import { sandbox } from "../testing/sandbox.js";
import { FLAGS } from "../usage.js";
import { EXAMPLE_CONFIG, referencePages } from "./reference.js";

const contentDir = path.resolve(
  import.meta.dirname,
  "../../docs/src/content/docs",
);
const page = (file: string): string =>
  referencePages().find((entry) => entry.file === file)?.markdown ?? "";
const USAGE_ERROR = 2;

// The committed pages are file snapshots. "npm run docs:reference" runs this test with --update, which writes them.
// Without --update a page that no longer matches the tables fails here, so a stale page cannot be merged.
test.each(referencePages())(
  "the committed $file is what the tables in the code say",
  async ({ file, markdown }) => {
    const formatted = await format(markdown, { parser: "markdown" });
    await expect(formatted).toMatchFileSnapshot(path.join(contentDir, file));
  },
);

test("the checks page has every check type and every field", () => {
  const checks = page("reference/checks.md");
  for (const type of Object.keys(CHECKS))
    expect(checks).toContain(`\`${type}\``);
  for (const field of Object.keys(FIELDS))
    expect(checks).toContain(`| \`${field}\` |`);
  for (const key of Object.keys(CASE_KEYS))
    expect(checks).toContain(`| \`${key}\` | \``);
  expect(checks).toMatch(
    /`tool_called` \| at least one of `kind`, `name`, optional `inputMatches`, optional `flags` \|/,
  );
  expect(checks).toMatch(
    /`file_matches` \| `path`, `pattern`, optional `flags`/,
  );
});

test("the commands page and the help text have every command, flag, and default", async () => {
  const commands = page("reference/commands.md");
  const help = (await sandbox().cli(["help"])).stderr;
  for (const [name, command] of Object.entries(COMMANDS)) {
    expect(commands).toContain(`| \`${name}\` | ${command.description} |`);
    expect(help).toContain(command.description);
  }
  for (const [flag, spec] of Object.entries(FLAGS)) {
    const value = "boolean" in spec ? "" : " <";
    expect(commands).toContain(`--${flag}${value}`);
    expect(commands).toContain(spec.description);
    expect(help).toMatch(
      new RegExp(`^  --${flag}${value}.*\\n      default: .*\\(.*\\)$`, "m"),
    );
    expect(help).toContain(spec.default);
  }
  expect(commands).toContain("the first installed one; all for check");
  expect(help).toContain("the first installed one; all for check");
  for (const key of Object.keys(CONFIG_KEYS)) expect(help).toContain(key);
});

test("the config page has every key with its flag, and its example file is accepted", async () => {
  const config = page("reference/config.md");
  expect(config).toContain(
    "| `judgeHarness` | string | `--judge-harness <id>` |",
  );
  expect(config).toContain("| `reps` | number | `--reps <n>` |");
  expect(Object.keys(EXAMPLE_CONFIG)).toEqual(Object.keys(CONFIG_KEYS));
  for (const [key, type] of Object.entries(CONFIG_KEYS))
    expect(
      Array.isArray(EXAMPLE_CONFIG[key])
        ? "string[]"
        : typeof EXAMPLE_CONFIG[key],
    ).toBe(type);

  const box = sandbox();
  box.write("skill-evals.config.json", EXAMPLE_CONFIG);
  box.write("evals/cases/hello/prompt.md", "say hello\n");
  box.write("evals/cases/hello/case.json", {
    checks: [{ type: "output_contains", text: "hello" }],
  });
  const listed = await box.cli(["list"]);
  expect(listed.status, listed.stderr).toBe(0);
  expect(listed.stdout).toContain("- hello: 1 checks");

  box.write("skill-evals.config.json", { ...EXAMPLE_CONFIG, colour: "red" });
  expect((await box.cli(["list"])).status).toBe(USAGE_ERROR);
});

test("the API page documents the exports of the package with their doc comments", () => {
  const api = page("reference/api.md");
  const exported = ["loadCases()", "evaluate()", "HARNESSES", "Case", "Check"];
  for (const name of [
    ...exported,
    "EvaluateOptions",
    "Evaluation",
    "RunRecord",
  ])
    expect(api).toContain(`\n### ${name}\n`);
  expect(api).toContain(
    "function evaluate(given: EvaluateOptions): Promise<Evaluation>",
  );
  expect(api).toContain(
    "| `decisionTimeout?` | `number \\| undefined` | The seconds one request to the decision model may take, a positive integer. Default: 60. |",
  );
  expect(api).toMatch(/^\*\*Throws `UsageError`\.\*\* For a wrong option/m);
  expect(api).toContain("| `outDir` | `string` |");
  expect(api).toContain("type CheckResult = Check & {");
  expect(api).toContain("const HARNESSES: Harness[]");
});

test("the harnesses page lists the registry in its order of preference", () => {
  const harnesses = page("agents/harnesses.md");
  const rows = HARNESSES.map(
    (harness, index) =>
      `| ${String(index + 1)} | \`${harness.id}\` | \`${harness.bin}\` |`,
  );
  for (const row of rows) expect(harnesses).toContain(row);
  expect(harnesses).toContain("`SKILL_EVALS_BIN_CLAUDE_CODE`");
});

test("the harnesses page shows every isolation switch and variable of every adapter", () => {
  const harnesses = page("agents/harnesses.md");
  for (const { isolation } of HARNESSES) {
    if (!isolation) continue;
    for (const arg of isolation.args) expect(harnesses).toContain(arg);
    for (const name of Object.keys(isolation.env)) {
      expect(harnesses).toContain(name);
    }
    expect(harnesses).toContain(isolation.notes.split("\n")[0] ?? "x");
  }
});
