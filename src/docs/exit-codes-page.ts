import { EXIT, EXIT_MEANINGS, PRECEDENCE } from "../exit-codes.js";
import type { ReferencePage } from "./markdown.js";
import { FENCE, code, header, table } from "./markdown.js";

/**
 * Writes the exit codes page from the `EXIT` table, so that the code is the only source.
 * @returns The page: every exit code with its meaning, the order in which they win, and the codes of `check` and
 *   `validate`.
 */
export function exitCodesPage(): ReferencePage {
  const names = Object.keys(EXIT) as (keyof typeof EXIT)[];
  const order = PRECEDENCE.map((value) => {
    const name = names.find((each) => EXIT[each] === value);
    return `${code(String(value))} (${name ?? ""})`;
  });
  return {
    file: "reference/exit-codes.md",
    markdown: `${header(
      {
        title: "Exit codes",
        description:
          "What run, score, check and validate exit with, and which code wins when several apply.",
      },
      "src/exit-codes.ts",
    )}

${code("run")} and ${code("score")} exit with one of these codes. ${code("summary.json")} in the output directory holds the same number as ${code("exit")}, and ${code("evaluate")} returns it as ${code("exit")}. [Use it in CI](../guides/ci.md) shows how to gate on them.

${table(
  ["Code", "Name", "Meaning"],
  names.map((name) => [code(String(EXIT[name])), name, EXIT_MEANINGS[name]]),
)}

## When several apply

The first of these wins: ${order.join(", ")}. A command that stopped at ${code("--max-cost")} and also has an invalid run exits 4, and one that has an invalid run and a missed bar exits 3. A usage error is raised before any run, so nothing else can apply with it.

## An invalid-run budget

By default one invalid run is enough to exit 3. ${code("--max-invalid <fraction>")} allows some. The command exits 3 only when the invalid runs divided by the planned runs of the cases that apply is greater than the fraction. A run that did not run, because a limit stopped the command, is not invalid and is not counted.

${FENCE}sh
# 3 runs are planned, 1 is invalid: 1/3 is not greater than 0.5, so the command exits 0 (or 1 if a bar is missed).
skill-evals score --subject ./skills --reps 3 --max-invalid 0.5
${FENCE}

The value is a number from 0 to 1. ${code("maxInvalid")} in the config file sets the default.

## Other commands

${table(
  ["Command", "Codes"],
  [
    [
      code("check"),
      `${code(String(EXIT.ok))} when every installed harness answered; ${code(String(EXIT.bar))} when one failed its run; ${code(String(EXIT.invalid))} when the subject directory changed while it ran; ${code(String(EXIT.usage))} for a wrong command line. A harness that is not installed is a row of the table, not a failure.`,
    ],
    [
      code("validate"),
      `${code(String(EXIT.ok))} when the suite has no problem (warnings do not count); ${code(String(EXIT.usage))} when it has at least one.`,
    ],
    [
      code("list"),
      `${code(String(EXIT.ok))}, or ${code(String(EXIT.usage))} for a wrong command line or case file.`,
    ],
    [
      code("plan"),
      `${code(String(EXIT.ok))}, or ${code(String(EXIT.usage))} for a wrong command line, case file or output directory. ${code("--dry-run")} on ${code("run")} and ${code("score")} prints the same and exits ${code(String(EXIT.ok))}.`,
    ],
  ],
)}

An internal failure in any command exits ${code(String(EXIT.error))} with a stack trace on standard error.
`,
  };
}
