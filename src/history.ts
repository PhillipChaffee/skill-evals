import type { Harness } from "./harnesses/shared.js";
import type { History, HistoryMode } from "./history-types.js";

/** What a run's stream file name ends with when it holds the seeded history, in place of `.transcript.json`. */
export const HISTORY_SUFFIX = ".history.json";

// A fence is at least three backticks.
const MIN_FENCE = 3;
const BACKTICKS = /`+/g;

/**
 * Picks the way a run's history reaches the agent.
 * @param harness - The adapter, which may name its own default.
 * @param forced - `--history-mode` or the config's `historyMode`; undefined when neither is set.
 * @returns The forced mode, else the adapter's own, else `preamble`: the mode that every adapter can do.
 */
export const modeFor = (
  harness: Pick<Harness, "historyMode">,
  forced?: HistoryMode,
): HistoryMode => forced ?? harness.historyMode ?? "preamble";

/**
 * Names the mode that a run's record keeps.
 * @param run - The case, the adapter and the forced mode.
 * @param run.caseDef - The case; only its `history` matters.
 * @param run.caseDef.history - The case's history, or undefined when it has none.
 * @param run.harness - The adapter.
 * @param run.forced - `--history-mode`, or undefined.
 * @returns The mode the history reached the agent in; null for a case with no history.
 */
export const recordedMode = (run: {
  caseDef: { history?: History | undefined };
  harness: Pick<Harness, "historyMode">;
  forced?: HistoryMode | undefined;
}): HistoryMode | null =>
  run.caseDef.history === undefined ? null : modeFor(run.harness, run.forced);

/**
 * Renders one message as plain lines.
 * @param message - A message of the history.
 * @param place - Its number in the history, from 1.
 * @returns The message under a header line, with each tool call and its result after the text.
 */
function renderMessage(message: History[number], place: number): string {
  const lines = [`[${String(place)}] ${message.role}`, message.text];
  for (const call of message.toolCalls ?? []) {
    lines.push(`[tool call] ${call.name} ${JSON.stringify(call.input)}`);
    if (call.output !== undefined) lines.push(`[tool result] ${call.output}`);
  }
  return lines.join("\n");
}

/**
 * Finds the longest run of backticks in a text.
 * @param text - Any text.
 * @returns The length of the longest run; 0 for none.
 */
const longestRun = (text: string): number =>
  Math.max(0, ...[...text.matchAll(BACKTICKS)].map(([run]) => run.length));

/**
 * Renders a history as the block that goes in front of the first message of a run, for a harness with no way to write
 * the history into its own store, or when `--history-mode preamble` says so. The words are neutral: they name no eval,
 * no case and no tool. The block is fenced with more backticks than any run of backticks in the history, so that no
 * line of the history can close the fence and pass for the user's own text.
 * @param history - The messages of `history.json`.
 * @returns The block: a heading with the number of messages, the fenced messages, and a line that says the next text
 *   is the latest message.
 */
export function renderPreamble(history: History): string {
  const body = history
    .map((message, index) => renderMessage(message, index + 1))
    .join("\n\n");
  const fence = "`".repeat(Math.max(MIN_FENCE, longestRun(body) + 1));
  return [
    `Earlier in this conversation (${String(history.length)} messages):`,
    "",
    fence,
    body,
    fence,
    "",
    "Latest message:",
  ].join("\n");
}

/**
 * Puts the preamble in front of the first message.
 * @param preamble - The block; null for a run with no history, or one whose history is written natively.
 * @param message - The first message.
 * @returns The message, with the block and a blank line before it when there is one.
 */
export const withPreamble = (
  preamble: string | null,
  message: string,
): string => (preamble === null ? message : `${preamble}\n\n${message}`);
