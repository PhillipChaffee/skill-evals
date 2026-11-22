import type { FieldDef } from "./fields.js";

/** The seconds a `command` check may take when it sets no `timeoutSeconds`. */
const DEFAULT_TIMEOUT_SECONDS = 120;

// The fields of the `command` check, in the order the docs list them.
export const COMMAND_FIELDS: Record<string, FieldDef> = {
  run: {
    type: "text",
    meaning:
      "Shell text, run with `/bin/sh -c` in the workspace after the agent exits. It runs as you, without a sandbox.",
  },
  expectExit: {
    type: "count",
    meaning: "The exit code that counts as success.",
    default: { value: { "*": 0 } },
  },
  stdoutMatches: {
    type: "regex",
    meaning:
      "A regular expression that the command's standard output must match.",
  },
  stdoutLacks: {
    type: "regex",
    meaning:
      "A regular expression that the command's standard output must not match.",
  },
  timeoutSeconds: {
    type: "int",
    meaning:
      "The seconds the command may take before its process group is killed. The check then scores 0 and the run stays valid.",
    default: { value: { "*": DEFAULT_TIMEOUT_SECONDS } },
  },
  scoreFrom: {
    type: "enum",
    values: ["exit", "stdout"],
    meaning:
      'How the check scores: "exit" gives 1 or 0, "stdout" reads a number from 0 to 1 on the last non-empty line of standard output, and anything else scores 0. The exit code and the patterns must hold either way.',
    default: { value: { "*": "exit" } },
  },
};
