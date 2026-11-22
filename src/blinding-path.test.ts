import fs from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { childEnv } from "./env.js";
import { CONFIG_FILE } from "./project.js";
import { plantBlind as plant, validated } from "./testing/blinding.js";
import { readResults, sandbox, seenBy } from "./testing/sandbox.js";
import type { Sandbox } from "./testing/sandbox.js";

const USAGE_ERROR = 2;

/**
 * Reads the sandbox's `PATH`.
 * @param box - The sandbox.
 * @returns The `PATH` that its commands run with.
 */
const pathOf = (box: Sandbox): string => box.env["PATH"] ?? "";

/**
 * Scores the planted case with no subject.
 * @param box - The sandbox.
 * @param env - Extra environment variables of the command.
 * @param more - Extra flags.
 * @returns The result of the command, and where it wrote.
 */
async function scored(
  box: Sandbox,
  env: Record<string, string>,
  more: string[] = [],
) {
  const out = path.join(box.root, "out");
  const ran = await box.cli(
    ["score", "--subject", "none", "--cases", `${box.root}/cases`, ...more],
    env,
  );
  return { ran, out };
}

test("childEnv leaves the entries that name this tool out of PATH, with one warning", () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const base = { PATH: "/a:/home/ci/skill-evals/node_modules/.bin:/b" };
  const input = {
    home: "/h",
    base,
    harnessEnv: {},
    authEnv: [],
    pass: [],
    withhold: [],
  };
  expect(childEnv(input)["PATH"]).toBe("/a:/b");
  expect(childEnv(input)["PATH"]).toBe("/a:/b");
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain(
    "/home/ci/skill-evals/node_modules/.bin",
  );
  warn.mockRestore();
});

test("a PATH that names the tool does not stop a run, and the agent does not see the entry", async () => {
  const box = sandbox();
  plant(box, "c", { files: { "workspace/notes.txt": "x" } });
  const named = path.join(box.root, "acme-skill-evals", "bin");
  fs.mkdirSync(named, { recursive: true });
  const { ran, out } = await scored(
    box,
    { PATH: `${pathOf(box)}${path.delimiter}${named}` },
    ["--out", path.join(box.root, "out"), "--reps", "1"],
  );
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stderr).toContain(
    `left out of the agent's PATH, because they name this tool: ${named}`,
  );
  const [record] = readResults(out).records;
  expect(seenBy(String(record?.finalText)).leaks).toBe(0);
});

test("a PATH entry that names the tool and holds node, or the harness, ends the command", async () => {
  const box = sandbox();
  plant(box, "c");
  const holder = path.join(box.root, "skill-evals-node");
  fs.mkdirSync(holder);
  fs.symlinkSync(process.execPath, path.join(holder, "node"));
  const withNode = await scored(box, {
    PATH: `${pathOf(box)}${path.delimiter}${holder}`,
  });
  expect(withNode.ran.status).toBe(USAGE_ERROR);
  expect(withNode.ran.stderr).toContain(
    `the PATH entry "${holder}" names this tool and holds node`,
  );
  const named = path.join(box.root, "skill-evals-agent");
  fs.mkdirSync(named);
  const agent = path.join(named, "agent.mjs");
  fs.copyFileSync(String(box.env["SKILL_EVALS_BIN_CLAUDE_CODE"]), agent);
  fs.chmodSync(agent, 0o755);
  const withAgent = await scored(box, {
    PATH: `${pathOf(box)}${path.delimiter}${named}`,
    SKILL_EVALS_BIN_CLAUDE_CODE: agent,
  });
  expect(withAgent.ran.status).toBe(USAGE_ERROR);
  expect(withAgent.ran.stderr).toContain(`holds ${agent}`);
  expect(fs.existsSync(box.started)).toBe(false);
});

test("the temp directory is read by its real path, and a custom word does not hit the tool's own prefixes", async () => {
  const box = sandbox();
  plant(box, "c");
  const real = path.join(box.root, "test-dir");
  fs.mkdirSync(real);
  const link = path.join(box.root, "neutral-link");
  fs.symlinkSync(real, link);
  const linked = await scored(box, { TMPDIR: link });
  expect(linked.ran.status).toBe(USAGE_ERROR);
  expect(linked.ran.stderr).toContain(`${real}" holds "test"`);

  // "skills-" is a prefix of this tool's, and "skill" is the user's word: not an error.
  box.write(CONFIG_FILE, { blindingWords: ["skill"] });
  const custom = await scored(box, {}, ["--reps", "1"]);
  expect(custom.ran.status, custom.ran.stderr).toBe(0);
});

test("--dry-run and plan skip the check of the machine", async () => {
  const box = sandbox();
  plant(box, "c");
  const env = { TMPDIR: "/var/tmp/test-area" };
  const dry = await scored(box, env, ["--dry-run"]);
  expect(dry.ran.status, dry.ran.stderr).toBe(0);
  const plan = await box.cli(
    ["plan", "--subject", "none", "--cases", `${box.root}/cases`],
    env,
  );
  expect(plan.status, plan.stderr).toBe(0);
});

test("validate scans the variables a case sets, and agrees with run", async () => {
  const box = sandbox();
  plant(box, "e", {
    file: { env: { CASE_BENCHMARK: "1", CASE_NOTE: "run the arena" } },
  });
  const text = (await validated(box)).lines.join("\n");
  expect(text).toContain(
    'the name of the variable CASE_BENCHMARK holds "benchmark"',
  );
  expect(text).toContain('the value of the variable CASE_NOTE holds "arena"');
  const ran = await scored(box, {});
  expect(ran.ran.status).toBe(USAGE_ERROR);
  expect(ran.ran.stderr).toContain(
    'the variable name CASE_BENCHMARK holds "benchmark"',
  );
});

test("session ids, tool-call names and mock responses are scanned as names and as prose", async () => {
  const box = sandbox();
  plant(box, "n", {
    files: {
      "history.json": [
        {
          role: "assistant",
          text: "ok",
          toolCalls: [
            { name: "run_tests", input: { file: "eval_results.json" } },
          ],
        },
      ],
      "sessions/sessions.json": [
        {
          id: "benchmark_run",
          startedAt: "2026-01-05T09:00:00Z",
          messages: [{ role: "user", text: "hi" }],
        },
      ],
      "mcp/s/t.json": {
        description: "d",
        inputSchema: {},
        responses: [{ text: "Fix test_parse in run_tests.py" }],
      },
    },
  });
  const text = (await validated(box)).lines.join("\n");
  expect(text).toContain('a tool call of message 1 holds "test"');
  expect(text).toContain('a tool call of message 1 holds "eval"');
  expect(text).toContain('the id of session benchmark_run holds "benchmark"');
  expect(text).toContain('a response of mcp/s/t.json holds "test"');
});

test("validate notes the subject's rule file paths that hold a word, and does not count them", async () => {
  const box = sandbox();
  plant(box, "c");
  box.write("skills/rules/test-first.md", "rule\n");
  box.write(CONFIG_FILE, { rules: "rules" });
  const { lines } = await validated(box);
  expect(lines[0]).toContain(
    "note: the subject's rule file paths hold a blinding word",
  );
  expect(lines[0]).toContain("test-first.md");
  expect(lines.at(-1)).toContain("1 warnings");
});
