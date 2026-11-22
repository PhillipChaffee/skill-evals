import fs from "node:fs";
import type {
  ToolCall,
  ToolKind,
  TranscriptEvent,
} from "./harnesses/shared.js";
import { toolCall } from "./harnesses/shared.js";

/** The main agent, which every event is attributed to until subagents are told apart. */
const MAIN_AGENT = { id: "main", type: "main", parent: null, depth: 0 };

/** The default cut of `forRecord`: the most bytes of one `text` or `output`. */
const RECORD_CAP_BYTES = 20_000;
const CONTINUATION_MASK = 0xc0;
const CONTINUATION = 0x80;
const INDENT = 2;

/** An event as an adapter states it: what it saw, and none of what is derived. */
export type EventInput = Pick<TranscriptEvent, "role" | "type"> &
  Partial<Omit<TranscriptEvent, "index" | "role" | "type">>;

/**
 * Completes one event.
 * @param partial - What the adapter read.
 * @param index - The event's position in the run.
 * @returns The event with its position, the main agent, the first user turn and no turn unless given, and `bytes`
 *   set to the UTF-8 size of its `text` or `output` as decoded.
 */
export function event(partial: EventInput, index = 0): TranscriptEvent {
  const text = partial.text ?? partial.output;
  return {
    turn: null,
    userTurn: 0,
    agent: { ...MAIN_AGENT },
    ...partial,
    index,
    ...(text === undefined ? {} : { bytes: Buffer.byteLength(text) }),
  };
}

/**
 * Builds a run's events in order.
 * @param parts - What the adapter read, in the order it happened.
 * @returns The events, each with its position. A `tool_result` without a name or kind takes them from the earlier call
 *   that has its `callId`.
 */
export function numbered(parts: EventInput[]): TranscriptEvent[] {
  const calls = new Map<string, EventInput>();
  return parts.map((part, position) => {
    if (part.type === "tool_call" && part.callId !== undefined) {
      calls.set(part.callId, part);
    }
    const made =
      part.type === "tool_result" && part.callId !== undefined
        ? calls.get(part.callId)
        : undefined;
    return event(
      {
        ...part,
        ...(part.name === undefined && made?.name !== undefined
          ? { name: made.name }
          : {}),
        ...(part.kind === undefined && made?.kind !== undefined
          ? { kind: made.kind }
          : {}),
      },
      position,
    );
  });
}

/**
 * Lists the tool calls of a transcript.
 * @param events - The run's events.
 * @returns One call for each `tool_call` event, in order. It has a `turn` only when its event has one.
 */
export const callsOf = (events: TranscriptEvent[]): ToolCall[] =>
  events
    .filter((e) => e.type === "tool_call")
    .map((e) => ({
      name: e.name ?? "",
      kind: e.kind ?? "other",
      input: e.input,
      ...(e.turn === null ? {} : { turn: e.turn }),
    }));

/**
 * Finds the calls whose tool result was an error.
 * @param events - The run's events.
 * @returns The positions, in `callsOf(events)`, of the calls whose result had `isError`. A result belongs to the latest
 *   earlier call with its `callId`; one that matches none is ignored.
 */
export function failedCalls(events: TranscriptEvent[]): Set<number> {
  const positions = new Map<string, number>();
  const failed = new Set<number>();
  let count = 0;
  for (const one of events) {
    if (one.type === "tool_call") {
      if (one.callId !== undefined) positions.set(one.callId, count);
      count += 1;
    } else if (one.type === "tool_result" && one.isError && one.callId) {
      const position = positions.get(one.callId);
      if (position !== undefined) failed.add(position);
    }
  }
  return failed;
}

/**
 * Writes the whole transcript, never cut.
 * @param stem - The run's path without an extension, the same as its stream file's.
 * @param events - The run's events.
 * @returns The file written: `<stem>.transcript.json`, pretty JSON.
 */
export function writeTranscript(
  stem: string,
  events: TranscriptEvent[],
): string {
  const file = `${stem}.transcript.json`;
  fs.writeFileSync(file, JSON.stringify(events, null, INDENT));
  return file;
}

/**
 * Cuts text to at most a number of bytes without splitting a character.
 * @param text - What to cut.
 * @param cap - The most bytes to keep.
 * @returns The start of the text.
 */
function cut(text: string, cap: number): string {
  const bytes = Buffer.from(text);
  let end = cap;
  while (end > 0 && ((bytes[end] ?? 0) & CONTINUATION_MASK) === CONTINUATION) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString();
}

/**
 * Makes the copy of a transcript that goes to the judge and the records.
 * @param events - The run's events.
 * @param capBytes - The most bytes of one `text` or `output`.
 * @returns The events, each long `text` or `output` cut, with `truncated: true`. `bytes` keeps the original size.
 */
export function forRecord(
  events: TranscriptEvent[],
  capBytes = RECORD_CAP_BYTES,
): TranscriptEvent[] {
  return events.map((one) => {
    const over = (value: string | undefined): value is string =>
      value !== undefined && Buffer.byteLength(value) > capBytes;
    if (!over(one.text) && !over(one.output)) return one;
    return {
      ...one,
      ...(over(one.text) ? { text: cut(one.text, capBytes) } : {}),
      ...(over(one.output) ? { output: cut(one.output, capBytes) } : {}),
      truncated: true,
    };
  });
}

/**
 * States a tool call.
 * @param kinds - The adapter's table of native tool name to kind.
 * @param call - The tool's name and input, and the id that joins its result.
 * @param call.name - The harness's own name of the tool.
 * @param call.input - The arguments of the call.
 * @param call.callId - The id of the call, when the stream has one.
 * @param extra - Fields to set besides, such as `turn`.
 * @returns The event, to give to `numbered`.
 */
export const callPart = (
  kinds: Record<string, ToolKind>,
  call: { name: string; input: unknown; callId?: string | undefined },
  extra: Partial<EventInput> = {},
): EventInput => ({
  role: "assistant",
  type: "tool_call",
  ...toolCall(kinds, call.name, call.input),
  ...(call.callId === undefined ? {} : { callId: call.callId }),
  ...extra,
});

/**
 * States what a tool returned.
 * @param callId - The id of the call it answers; absent when the stream has none.
 * @param output - The tool's output as text.
 * @param extra - Fields to set besides, such as `isError` and `durationMs`.
 * @returns The event, to give to `numbered`.
 */
export const resultPart = (
  callId: string | undefined,
  output: string,
  extra: Partial<EventInput> = {},
): EventInput => ({
  role: "tool",
  type: "tool_result",
  ...(callId === undefined ? {} : { callId }),
  output,
  ...extra,
});

/**
 * States what the assistant said.
 * @param text - What the assistant wrote.
 * @param extra - Fields to set besides, such as `turn`.
 * @returns The event, to give to `numbered`.
 */
export const textPart = (
  text: string,
  extra: Partial<EventInput> = {},
): EventInput => ({ role: "assistant", type: "text", text, ...extra });

/**
 * Joins the text of a list of content blocks.
 * @param blocks - Blocks of a message or a tool result; those that are not text, and a value that is no list, add nothing.
 * @returns The text of the `text` blocks, joined without a separator.
 */
export const joinText = (blocks: unknown): string =>
  Array.isArray(blocks)
    ? (blocks as { type?: string; text?: string }[])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("")
    : "";
