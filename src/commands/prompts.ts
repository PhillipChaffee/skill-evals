import type { Case } from "../cases.js";
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
 * Lists what a case sends the agent, for a person who is about to approve it.
 * @param caseDef - A loaded case.
 * @returns One block for each turn, in order, or the one prompt; then a line that says whether a history preamble is
 *   added in front of the first.
 */
export function promptLines(caseDef: Case): string[] {
  const sent = caseDef.turns
    ? caseDef.turns.flatMap((turn, index) =>
        block(`turn ${String(index + 1)}`, describeTurn(turn)),
      )
    : block("prompt", caseDef.prompt);
  const history = caseDef.history
    ? `a preamble of ${String(caseDef.history.length)} messages is added in front of the first prompt (the default mode; native mode resumes a seeded session instead)`
    : "no preamble is added";
  return [...sent, `    history: ${history}`];
}
