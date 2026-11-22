import path from "node:path";
import claudeCode from "../harnesses/claude-code.js";
import type { Harness } from "../harnesses/shared.js";
import { session } from "../session.js";
import type { Turn } from "../turn-spec.js";
import type { Sandbox } from "./sandbox.js";
import { readResults } from "./sandbox.js";

const SHELL_PATH = "/usr/local/bin:/usr/bin:/bin";
const SEEN = { type: "output_matches", pattern: "." };

/**
 * Plants a case whose turns are the given ones, with a prompt file for each prompt.
 * @param box - The sandbox.
 * @param turns - The `turns` of the case file.
 * @param more - More keys of the case file.
 * @returns The cases directory.
 */
export function planted(
  box: Sandbox,
  turns: unknown[],
  more: Record<string, unknown> = {},
): string {
  box.write("cases/talk/one.md", "do talk, first\n");
  box.write("cases/talk/two.md", "the follow-up\n");
  box.write("cases/talk/case.json", { checks: [SEEN], turns, ...more });
  return path.join(box.root, "cases");
}

/**
 * Scores the cases of a sandbox with the fake harness, on Claude Code and optionally Pi.
 * @param box - The sandbox.
 * @param harnesses - The harness ids.
 * @returns The command's result and `results.json`.
 */
export async function scored(box: Sandbox, harnesses = "claude-code") {
  const out = path.join(box.root, "results");
  const ran = await box.cli(
    [
      ...["score", "--subject", "none", "--reps", "1", "--out", out],
      ...["--cases", path.join(box.root, "cases"), "--harness", harnesses],
    ],
    {
      SKILL_EVALS_BIN_PI: box.pi,
      PATH: `${String(box.env["PATH"])}:${SHELL_PATH}`,
    },
  );
  return { ran, results: readResults(out) };
}

// Claude Code has no confirmed way to compact in `-p`, so it does not declare `compact`. This harness does, by sending
// `/compact` in a resumed session, which the fake answers with a compact_boundary event.
export const compacting: Harness = {
  ...claudeCode,
  capabilities: new Set([...claudeCode.capabilities, "compact"]),
  invocation: (input) =>
    claudeCode.invocation({
      ...input,
      prompt: input.turn.event === "compact" ? "/compact" : input.prompt,
    }),
};

/**
 * Runs turns through the session runner with the fake harness behind `harness`.
 * @param box - The sandbox, whose fake scripts are used.
 * @param harness - The adapter that parses the stream and builds the command line.
 * @param turns - The turns of the case.
 * @returns What the session produced.
 */
export function played(box: Sandbox, harness: Harness, turns: Turn[]) {
  return session(
    {
      harness,
      bin: String(box.env["SKILL_EVALS_BIN_CLAUDE_CODE"]),
      subject: null,
      prompt: "unused",
      turns,
      timeoutSeconds: 30,
      pass: [],
    },
    (result) => result,
  );
}

/**
 * Makes a prompt turn.
 * @param file - The prompt file's name.
 * @param text - The message it holds.
 * @returns The turn, with no checks.
 */
export const say = (file: string, text: string): Turn => ({
  prompt: text,
  file,
  checks: [],
});
