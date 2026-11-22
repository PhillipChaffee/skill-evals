import type { CommandResult } from "../command.js";
import { runCommand } from "../command.js";
import type { Rule, Spec, Verdict, With } from "./index.js";
import { regex } from "./rules.js";

const KEPT_BYTES = 2000;
const DEFAULT_TIMEOUT_SECONDS = 120;
const SHOWN_LINE_LENGTH = 80;
const UTF8_CONTINUATION = 0b1000_0000;
const UTF8_CONTINUATION_MASK = 0b1100_0000;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Cuts text to its last bytes without splitting a character.
 * @param text - What a command wrote.
 * @param limit - The most bytes to keep.
 * @returns The text when it fits, else its end, starting on a character boundary.
 */
function lastBytes(text: string, limit = KEPT_BYTES): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let start = bytes.length - limit;
  while (
    start < bytes.length &&
    ((bytes[start] ?? 0) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION
  ) {
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}

/**
 * Reads the score a command printed.
 * @param stdout - Everything the command wrote to standard output.
 * @returns The number on its last non-empty line, from 0 to 1, or why there is none.
 */
function ratioOf(
  stdout: string,
): { score: number; problem: null } | { score: 0; problem: string } {
  const line = stdout
    .split("\n")
    .map((each) => each.trim())
    .filter((each) => each !== "")
    .at(-1);
  const shown =
    line === undefined
      ? "nothing"
      : JSON.stringify(
          line.length > SHOWN_LINE_LENGTH
            ? `${line.slice(0, SHOWN_LINE_LENGTH)}...`
            : line,
        );
  const value = line !== undefined && NUMBER.test(line) ? Number(line) : NaN;
  return value >= 0 && value <= 1
    ? { score: value, problem: null }
    : {
        score: 0,
        problem: `the last line of stdout is ${shown}, not a number from 0 to 1`,
      };
}

/**
 * Says why a finished command does not pass.
 * @param check - The command check.
 * @param result - What the command did.
 * @returns The first thing that fails, or null when it passes.
 */
function shortfall(check: With<"run">, result: CommandResult): string | null {
  const expected = check.expectExit ?? 0;
  if (result.exit !== expected) {
    return `expected exit ${String(expected)}`;
  }
  const { stdoutMatches, stdoutLacks, flags } = check;
  if (stdoutMatches && !regex(stdoutMatches, flags).test(result.stdout)) {
    return `stdout does not match /${stdoutMatches}/`;
  }
  if (stdoutLacks && regex(stdoutLacks, flags).test(result.stdout)) {
    return `stdout matches /${stdoutLacks}/`;
  }
  return null;
}

/**
 * Scores a command check from what its command did.
 * @param check - The check, with its `run` and the fields that say what passes.
 * @param result - What the command did.
 * @returns A score from 0 to 1 and why, with the record of what the command did.
 */
function verdictOf(check: With<"run">, result: CommandResult): Verdict {
  const stderr = lastBytes(result.stderr);
  const command = {
    run: check.run,
    exit: result.exit,
    durationMs: result.durationMs,
    stdout: lastBytes(result.stdout),
    stderr,
  };
  const timeout = check.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (result.failure === "timeout") {
    return {
      score: 0,
      reason: `timed out after ${String(timeout)} s`,
      command,
    };
  }
  if (result.failure === "spawn") {
    return { score: 0, reason: `could not start: ${stderr}`, command };
  }
  const took = `exit ${String(result.exit)} in ${String(result.durationMs)} ms`;
  const problem = shortfall(check, result);
  const ratio =
    check.score === "stdout"
      ? ratioOf(result.stdout)
      : { score: 1, problem: null };
  const failed = problem ?? ratio.problem;
  if (failed === null) return { score: ratio.score, reason: took, command };
  const tail = stderr.trim() === "" ? "" : `: ${stderr.trim()}`;
  return { score: 0, reason: `${took}, ${failed}${tail}`, command };
}

const commandRule: Rule = async (check, outcome) => {
  const given = check as With<"run">;
  const result = await runCommand(
    given.run,
    outcome.command,
    given.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
  );
  return verdictOf(given, result);
};

// The check that runs a command after the agent exits.
export const COMMAND_CHECKS = {
  command: {
    fields: ["run"],
    optional: [
      ...["expectExit", "stdoutMatches", "stdoutLacks", "flags"],
      ...["timeoutSeconds", "score"],
    ],
    scores:
      "The command exits with the expected code and its standard output passes. With `score: stdout`, the score is the number on the last line of standard output.",
    note: "It runs after the agent exits, in the workspace, as you, without a sandbox. See the safety page.",
    rule: commandRule,
  } satisfies Spec,
};
