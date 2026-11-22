import type { Case } from "../cases.js";
import { allChecks } from "../case-checks.js";
import { renderPreamble } from "../history.js";
import { describeTurn } from "../turn-spec.js";

/**
 * Indents a text under a label.
 * @param label - What the text is.
 * @param text - The text, which may have several lines.
 * @returns The lines, each indented, with the label on the first.
 */
const block = (label: string, text: string): string[] =>
  text
    .trimEnd()
    .split("\n")
    .map((line, at) => (at === 0 ? `    ${label}: ${line}` : `      ${line}`));

/**
 * Lists the shell commands of a case, which run on the machine as the operator: the setup steps before the agent, and
 * the command checks after it.
 * @param caseDef - A loaded case.
 * @returns One line for each `run` of a setup step and of a command check.
 */
const commandLines = (caseDef: Case): string[] => [
  ...caseDef.setup.flatMap((step) =>
    "run" in step
      ? [`    setup: ${step.run}`]
      : [`    setup (git): ${JSON.stringify(step.git)}`],
  ),
  ...allChecks(caseDef).flatMap((check) =>
    check.type === "command" && check.run !== undefined
      ? [`    command check: ${check.run}`]
      : [],
  ),
];

/**
 * Lists what a case sends the agent, and what it runs, for a person who is about to approve it.
 * @param caseDef - A loaded case.
 * @returns One block for each turn, in order, or the one prompt; the history preamble with each of its messages, or a
 *   line that says none is added; then the setup steps and command checks.
 */
export function promptLines(caseDef: Case): string[] {
  const sent = caseDef.turns
    ? caseDef.turns.flatMap((turn, index) =>
        block(`turn ${String(index + 1)}`, describeTurn(turn)),
      )
    : block("prompt", caseDef.prompt);
  const history = caseDef.history
    ? block(
        `history: a preamble of ${String(caseDef.history.length)} messages is added in front of the first prompt (the default mode; native mode resumes a seeded session instead)`,
        renderPreamble(caseDef.history),
      )
    : ["    history: no preamble is added"];
  return [...sent, ...history, ...commandLines(caseDef)];
}
