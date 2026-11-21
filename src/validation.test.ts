import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { plantCase, plugin } from "./testing/plant.js";
import { sandbox } from "./testing/sandbox.js";

const USAGE_ERROR = 2;

/**
 * Plants one plugin and a `run` that compares it with itself.
 * @returns The sandbox, the cases directory, and `run`, which takes one case file's content and extra flags.
 */
function rejecting() {
  const box = sandbox();
  const pluginA = plugin(box, "plugin-alpha", { costUsd: 0.01 });
  const outDir = path.join(box.root, "results");
  const cases = plantCase(box, []);
  const run = (caseFile: unknown, ...extra: string[]) => {
    box.write("cases/restate/case.json", caseFile);
    const flags = ["--out", outDir, "--cases", cases, ...extra];
    return box.cli(["run", "--a", pluginA, "--b", pluginA, ...flags]);
  };
  return { box, outDir, run };
}

const fine = { type: "file_exists", path: "notes.txt" };
const BAD_CASES: [unknown, RegExp][] = [
  [
    { checks: [{ type: "smells_right", skill: "bro" }] },
    /unknown check type "smells_right"/,
  ],
  [{ checks: [null] }, /unknown check type undefined/],
  [
    { checks: [{ ...fine, path: "../outside.txt" }] },
    /path must stay inside the workspace/,
  ],
  [
    { checks: [{ ...fine, path: "/etc/passwd" }] },
    /path must stay inside the workspace/,
  ],
  [
    { checks: [{ type: "output_matches", pattern: "(" }] },
    /Invalid regular expression/,
  ],
  [{ checks: [] }, /non-empty/],
  [null, /non-empty/],
  [{ checks: [{ ...fine, weight: 0 }] }, /weight must be a positive number/],
  [{ checks: [fine], weight: -1 }, /weight must be a positive number/],
  [{ checks: [fine], minScore: 1.5 }, /minScore must be a number from 0 to 1/],
  [{ checks: [fine], maxTurns: 1.5 }, /maxTurns must be a positive integer/],
  [
    { checks: [fine], timeoutSeconds: 0 },
    /timeoutSeconds must be a positive integer/,
  ],
  [
    { checks: [{ type: "tool_called", inputMatches: "push" }] },
    /at least one of "kind", "name"/,
  ],
  [
    { checks: [{ type: "tool_called", kind: "terminal" }] },
    /unknown tool kind "terminal"/,
  ],
  [
    { checks: [{ type: "tool_not_called", name: "(" }] },
    /Invalid regular expression/,
  ],
  [{ checks: [{ type: "output_contains" }] }, /needs a string "text"/],
  [
    { checks: [{ type: "output_contains", text: "" }] },
    /needs a string "text"/,
  ],
  [{ checks: [{ type: "judge" }] }, /needs a string "rubric"/],
  ["{ not json", /case restate: /],
];

test.each(BAD_CASES)(
  "run rejects the case file %j before it starts any harness",
  async (caseFile, message) => {
    const { outDir, run } = rejecting();
    const result = await run(caseFile);
    expect(result.status).toBe(USAGE_ERROR);
    expect(result.stderr).toMatch(message);
    expect(result.stderr, "no stack trace").not.toMatch(/\n\s+at /);
    expect(fs.existsSync(path.join(outDir, "results.json"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "claude-code"))).toBe(false);
  },
);

const BAD_FLAGS: [string[], RegExp][] = [
  [["--harness", "emacs"], /unknown harness "emacs"/],
  [["--harness", "codex"], /harness not installed: codex/],
  [["--judge-harness", "emacs"], /unknown harness "emacs"/],
  [["--min-score", "1.2"], /minScore must be a number from 0 to 1/],
  [["--case", "no-such-*"], /no case in .* matches "no-such-\*"/],
  [["--reps", "0"], /reps must be a positive integer/],
  [["--b", "no-such-ref-or-dir"], /not a directory/],
  [["--cases", "no-such-dir"], /cannot read the cases directory .*\(ENOENT\)/],
  [["--frobnicate", "1"], /Unknown option '--frobnicate'/],
];

test.each(BAD_FLAGS)(
  "run rejects the flags %j before it starts any harness",
  async (flags, message) => {
    const { outDir, run } = rejecting();
    const result = await run({ checks: [fine] }, ...flags);
    expect(result.status).toBe(USAGE_ERROR);
    expect(result.stderr).toMatch(message);
    expect(fs.existsSync(path.join(outDir, "results.json"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "claude-code"))).toBe(false);
  },
);

test("a case with an empty prompt, and a command line with no known command, are usage errors", async () => {
  const { box, run } = rejecting();
  box.write("cases/restate/prompt.md", "\n");
  const emptyPrompt = await run({ checks: [fine] });
  expect(emptyPrompt.status).toBe(USAGE_ERROR);
  expect(emptyPrompt.stderr).toMatch(/prompt\.md is empty/);

  const unknown = await box.cli(["frobnicate"]);
  expect(unknown.status).toBe(USAGE_ERROR);
  expect(unknown.stderr).toMatch(
    /^skill-evals: unknown command "frobnicate"\n\nUsage: /,
  );
  const inherited = await box.cli(["constructor"]);
  expect(inherited.stderr).toMatch(/unknown command "constructor"/);
  const missing = await box.cli([]);
  expect(missing.status).toBe(USAGE_ERROR);
  expect(missing.stderr).toMatch(/^skill-evals: missing command\n\nUsage: /);
});

test("with no harness installed, score names the ones it looked for", async () => {
  const { box } = rejecting();
  const flags = ["--subject", "none", "--cases", path.join(box.root, "cases")];
  box.write("cases/restate/case.json", { checks: [fine] });
  const none = await box.cli(["score", ...flags], {
    SKILL_EVALS_BIN_CLAUDE_CODE: "",
  });
  expect(none.status).toBe(USAGE_ERROR);
  expect(none.stderr).toMatch(
    /no harness is installed; looked for pi, claude-code, cursor, opencode, codex/,
  );
});
