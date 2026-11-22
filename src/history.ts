import type { Harness, TranscriptEvent } from "./harnesses/shared.js";
import type { History, HistoryMode } from "./history-types.js";
import type { EventInput } from "./transcript.js";
import { numbered } from "./transcript.js";

/** The `userTurn` of every event that comes from a seeded history. No check reads an event with it. */
export const HISTORY_TURN = -1;

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

/**
 * Turns a history into the events that go in the transcript.
 * @param history - The messages of `history.json`.
 * @returns One `text` event for each message, and a `tool_call` and, where there is an output, a `tool_result` for each
 *   call, all with `userTurn` -1 and positions from 0. A call has the kind `other`: the history names tools in the
 *   harness's words, and no check reads it.
 */
export function historyEvents(history: History): TranscriptEvent[] {
  let calls = 0;
  const parts = history.flatMap((message): EventInput[] => [
    {
      role: message.role,
      type: "text",
      text: message.text,
      userTurn: HISTORY_TURN,
    },
    ...(message.toolCalls ?? []).flatMap((call): EventInput[] => {
      const callId = `history-${String((calls += 1))}`;
      return [
        {
          role: "assistant",
          type: "tool_call",
          kind: "other",
          name: call.name,
          input: call.input,
          callId,
          userTurn: HISTORY_TURN,
        },
        ...(call.output === undefined
          ? []
          : [
              {
                role: "tool",
                type: "tool_result",
                callId,
                output: call.output,
                userTurn: HISTORY_TURN,
              } satisfies EventInput,
            ]),
      ];
    }),
  ]);
  return numbered(parts);
}

/**
 * Numbers events by their place in the list.
 * @param events - Events in order.
 * @returns The same events with `index` set to the place, from 0.
 */
const renumbered = (events: TranscriptEvent[]): TranscriptEvent[] =>
  events.map((one, index) => ({ ...one, index }));

/**
 * Puts the seeded history in front of a run's events, for the transcript file.
 * @param seeded - What `historyEvents` made; empty for a run with no history.
 * @param events - The agent's events.
 * @returns The two lists as one, numbered from 0; the agent's events themselves when there is no history.
 */
export const withHistory = (
  seeded: TranscriptEvent[],
  events: TranscriptEvent[],
): TranscriptEvent[] =>
  seeded.length === 0 ? events : renumbered([...seeded, ...events]);

/**
 * Takes the seeded history out of a transcript that was written with it.
 * @param events - The events of a transcript file.
 * @returns The agent's events, numbered from 0 as they were before the history was put in; the same list when it has
 *   no history.
 */
export function agentEvents(events: TranscriptEvent[]): TranscriptEvent[] {
  const own = events.filter((one) => one.userTurn !== HISTORY_TURN);
  return own.length === events.length ? events : renumbered(own);
}
