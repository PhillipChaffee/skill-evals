import fs from "node:fs";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { findProject } from "./project.js";
import { gitRepo, readResults, sandbox, seenBy } from "./testing/sandbox.js";

const HELLO_PROMPT = "evals/cases/hello/prompt.md";
const HELLO_CASE = "evals/cases/hello/case.json";
const GREET_SKILL = "skills/greet/SKILL.md";
const CONFIG_FILE = "skill-evals.config.json";
const USAGE_ERROR = 2;

test("the project root is the git top level of a nested working directory", () => {
  const box = sandbox();
  gitRepo(box.root);
  const nested = path.dirname(box.write("packages/app/notes.txt", "x"));
  expect(findProject(nested)).toEqual({
    root: box.root,
    isGitRepo: true,
    cwd: nested,
  });
});

test("outside a git repo the project root is the working directory", () => {
  const box = sandbox();
  expect(findProject(box.root)).toEqual({
    root: box.root,
    isGitRepo: false,
    cwd: box.root,
  });
});

test("run --a main outside a git repo exits 2 and names the folder", async () => {
  const box = sandbox();
  box.write(HELLO_PROMPT, "say hello\n");
  box.write(HELLO_CASE, {
    checks: [{ type: "output_contains", text: "hello" }],
  });

  const result = await box.cli(["run", "--a", "main"]);
  expect(result.status).toBe(USAGE_ERROR);
  expect(result.stderr).toContain(box.root);
  expect(result.stderr, "no stack trace").not.toMatch(/\n\s+at /);
});

test("score with no flags uses <root>/evals/cases and the working tree", async () => {
  const box = sandbox();
  gitRepo(box.root);
  box.write(HELLO_PROMPT, "say hello\n");
  box.write(HELLO_CASE, {
    checks: [{ type: "file_exists", path: "out/summary.txt" }],
  });
  box.write(GREET_SKILL, "Say hello.\n");
  const nested = path.dirname(box.write("packages/app/notes.txt", "x"));

  const result = await box.cli(["score", "--reps", "1"], {}, nested);
  expect(result.status, result.stderr).toBe(0);
  const outDir = /^- Output: (.+)$/m.exec(result.stdout)?.[1] ?? "";
  onTestFinished(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });
  const { subjects, records } = readResults(outDir);
  expect(subjects.map(({ dir, skills }) => [dir, skills])).toEqual([
    [box.root, ["greet"]],
  ]);
  expect(records.map((r) => `${r.caseId} ${String(r.score)}`)).toEqual([
    "hello 1",
  ]);
  expect(path.basename(outDir)).toMatch(/^runs-/);
});

test("list shows the harnesses in preference order, the default one, and the cases", async () => {
  const box = sandbox();
  const empty = await box.cli(["list"]);
  expect(empty.status).toBe(0);
  expect(empty.stdout).toMatch(/pi.*claude-code.*cursor.*opencode.*codex/s);
  expect(empty.stdout).toMatch(/^- pi: not installed \("pi" not found\)$/m);
  expect(empty.stdout).toMatch(
    /^- claude-code: installed \(.*fake-agent\.mjs\)$/m,
  );
  expect(empty.stdout).toMatch(/^Default harness: claude-code$/m);
  expect(empty.stdout).toMatch(/^- none: the directory does not exist$/m);

  box.write(HELLO_PROMPT, "say hello\n");
  box.write(HELLO_CASE, {
    checks: [{ type: "output_contains", text: "hello" }],
  });
  const one = await box.cli(["list"], { SKILL_EVALS_BIN_CLAUDE_CODE: "" });
  expect(one.stdout).toMatch(/^Default harness: none installed$/m);
  expect(one.stdout).toContain(
    `Cases in ${path.join(box.root, "evals/cases")}:\n- hello: 1 checks`,
  );
  const elsewhere = await box.cli(["list", "--cases", "evals/cases"]);
  expect(elsewhere.stdout).toMatch(/^- hello: 1 checks$/m);
});

/**
 * Plants a project whose config file holds `config`, with one skill and one case that no run passes.
 * @param config - The content of the config file; text is written as it is.
 * @returns The sandbox, and a `score` that runs with extra flags and reads the results unless the command line was wrong.
 */
function configured(config: unknown) {
  const box = sandbox();
  box.write(CONFIG_FILE, config);
  box.write(GREET_SKILL, "Say hello.\n");
  box.write("my-cases/hello/prompt.md", "say hello\n");
  box.write("my-cases/hello/case.json", {
    checks: [{ type: "output_contains", text: "no such text" }],
  });
  const outDir = path.join(box.root, "results");
  const score = async (...flags: string[]) => {
    const result = await box.cli(["score", "--out", outDir, ...flags]);
    const results =
      result.status === USAGE_ERROR ? undefined : readResults(outDir);
    return { result, results };
  };
  return { box, score };
}

const runs = (records: ReturnType<typeof readResults>["records"] = []) =>
  records.map(
    (r) => `${r.caseId} ${String(r.rep)} ${String(seenBy(r.finalText).model)}`,
  );

test("config values become defaults and flags override them", async () => {
  const { score } = configured({
    cases: "my-cases",
    reps: 2,
    model: "config-model",
    judgeModel: "config-judge",
    minScore: 0.5,
  });

  const fromConfig = await score();
  expect(fromConfig.result.status, "under the configured bar").toBe(1);
  expect(runs(fromConfig.results?.records)).toEqual([
    "hello 1 config-model",
    "hello 2 config-model",
  ]);
  expect(fromConfig.results?.judge).toBe(
    "the harness under test, model config-judge",
  );
  expect(fromConfig.result.stdout).toMatch(
    /suite score 0\.00 \(2 of 2 runs\) does not reach --min-score 0\.50/,
  );

  const flags = ["--reps", "1", "--model", "flag-model"];
  const fromFlags = await score(
    ...flags,
    "--judge-model",
    "flag-judge",
    "--min-score",
    "0",
  );
  expect(fromFlags.result.status, fromFlags.result.stderr).toBe(0);
  expect(runs(fromFlags.results?.records)).toEqual(["hello 1 flag-model"]);
  expect(fromFlags.results?.judge).toBe(
    "the harness under test, model flag-judge",
  );
});

const BAD_CONFIGS: [unknown, RegExp][] = [
  [
    { cases: "my-cases", repetitions: 2 },
    /skill-evals\.config\.json: unknown key "repetitions"/,
  ],
  [{ cases: "my-cases", reps: "2" }, /"reps" must be a number/],
  [["my-cases"], /must hold one JSON object/],
  ["{ cases: ", /skill-evals\.config\.json: /],
];

test.each(BAD_CONFIGS)(
  "the config %j is a usage error that names the file",
  async (config, message) => {
    const { box, score } = configured(config);
    const { result } = await score();
    expect(result.status).toBe(USAGE_ERROR);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain(path.join(box.root, CONFIG_FILE));
    expect(result.stderr, "no stack trace").not.toMatch(/\n\s+at /);
  },
);
