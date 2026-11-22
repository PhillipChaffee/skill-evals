import fs from "node:fs";
import type {
  HookEvent,
  LifecycleEvent,
  ToolCall,
  ToolKind,
  TranscriptEvent,
} from "./harnesses/shared.js";
import { NO_DISPATCH, joinText, toolCall } from "./harnesses/shared.js";
import { shownHook } from "./harnesses/hook.js";
import { MAIN_AGENT } from "./agents.js";

/** The default cut of `forRecord`: the most bytes of one `text` or `output`. */
const RECORD_CAP_BYTES = 20_000;
const CONTINUATION_MASK = 0xc0;
const CONTINUATION = 0x80;
const INDENT = 2;

/** An event as an adapter states it: what it saw, and none of what is derived. */
export type EventInput = Pick<TranscriptEvent, "role" | "type"> &
  Partial<Omit<TranscriptEvent, "index" | "role" | "type">>;

/**
 * Turns whatever a stream held in a text field into text.
 * @param value - A string, a list of content blocks, or anything else a stream may carry.
 * @returns A string as it is; a list of blocks as its joined text; undefined as undefined; any other value as JSON, or
 *   as `String(value)` when JSON cannot write it. It never throws.
 */
function asText(value: unknown): string | undefined {
  if (typeof value === "string" || value === undefined) return value;
  if (Array.isArray(value)) return joinText(value);
  // Only a function, a symbol or a bigint is left that JSON cannot write whole.
  const plain = value as bigint | (() => unknown);
  try {
    // JSON.stringify gives undefined, whatever its declared type, for a function or a symbol.
    const json: unknown = JSON.stringify(value);
    return typeof json === "string" ? json : String(plain);
  } catch {
    return String(plain);
  }
}

/**
 * Completes one event.
 * @param partial - What the adapter read.
 * @param index - The event's position in the run.
 * @returns The event with its position, the main agent unless it names one, the first user turn and no turn unless given, and `bytes`
 *   set to the UTF-8 size of its `text` or `output` as decoded.
 */
export function event(partial: EventInput, index = 0): TranscriptEvent {
  const { text: rawText, output: rawOutput, ...rest } = partial;
  const text = asText(rawText);
  const output = asText(rawOutput);
  const sized = text ?? output;
  return {
    turn: null,
    userTurn: 0,
    agent: { ...MAIN_AGENT },
    ...rest,
    ...(text === undefined ? {} : { text }),
    ...(output === undefined ? {} : { output }),
    index,
    ...(sized === undefined ? {} : { bytes: Buffer.byteLength(sized) }),
  };
}

/**
 * Builds a run's events in order.
 * @param parts - What the adapter read, in the order it happened.
 * @returns The events, each with its position. A `tool_result` without a name, kind or turn takes them from the
 *   earlier call that has its `callId`; an empty `callId` joins nothing.
 */
export function numbered(parts: EventInput[]): TranscriptEvent[] {
  const calls = new Map<string, EventInput>();
  return parts.map((part, position) => {
    if (part.type === "tool_call" && part.callId) {
      calls.set(part.callId, part);
    }
    const made =
      part.type === "tool_result" && part.callId
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
        ...(part.turn === undefined && made?.turn !== undefined
          ? { turn: made.turn }
          : {}),
      },
      position,
    );
  });
}

/**
 * Pairs each tool call with its tool result.
 * @param events - The run's events.
 * @returns For the position of a call in `callsOf(events)`, the result that answers it: the first with the call's
 *   `callId` after it and before the next call with that id. A result that matches none, and an empty `callId`, pair
 *   with nothing.
 */
export function resultsByCall(
  events: TranscriptEvent[],
): Map<number, TranscriptEvent> {
  const open = new Map<string, number>();
  const paired = new Map<number, TranscriptEvent>();
  let count = 0;
  for (const one of events) {
    if (one.type === "tool_call") {
      if (one.callId) open.set(one.callId, count);
      count += 1;
    } else if (one.type === "tool_result" && one.callId) {
      const position = open.get(one.callId);
      if (position !== undefined && !paired.has(position)) {
        paired.set(position, one);
      }
    }
  }
  return paired;
}

/**
 * Lists the tool calls of a transcript.
 * @param events - The run's events.
 * @returns One call for each `tool_call` event, in order, with the agent of its event, and the dispatch of a `subagent` call (nulls when its adapter read none). It has a `turn` only when its event has one, and a
 *   `durationMs` only when its result has one.
 */
export function callsOf(events: TranscriptEvent[]): ToolCall[] {
  const paired = resultsByCall(events);
  return events
    .filter((e) => e.type === "tool_call")
    .map((e, position) => {
      const durationMs = paired.get(position)?.durationMs;
      return {
        name: e.name ?? "",
        kind: e.kind ?? "other",
        input: e.input,
        agent: e.agent,
        // An adapter that attaches no `dispatch` to its subagent calls gets all nulls, never a missing field.
        ...(e.kind === "subagent"
          ? { dispatch: e.dispatch ?? { ...NO_DISPATCH } }
          : {}),
        ...(e.source === undefined ? {} : { source: e.source }),
        ...(e.native === undefined ? {} : { native: e.native }),
        ...(e.turn === null ? {} : { turn: e.turn }),
        ...(durationMs === undefined ? {} : { durationMs }),
      };
    });
}

/**
 * Finds the calls whose tool result was an error.
 * @param events - The run's events.
 * @returns The positions, in `callsOf(events)`, of the calls whose result had `isError`.
 */
export const failedCalls = (events: TranscriptEvent[]): Set<number> =>
  new Set(
    [...resultsByCall(events)]
      .filter(([, result]) => result.isError)
      .map(([position]) => position),
  );

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
  return events.map((hooked) => {
    // A hook's context is shown cut at 4,000 characters, though the transcript file keeps more for the checks.
    const one = hooked.hook
      ? { ...hooked, hook: shownHook(hooked.hook) }
      : hooked;
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
 * @param output - The tool's output as text; undefined when the stream carries none, so the result has no `output`.
 * @param extra - Fields to set besides, such as `isError` and `durationMs`.
 * @returns The event, to give to `numbered`.
 */
export const resultPart = (
  callId: string | undefined,
  output: string | undefined,
  extra: Partial<EventInput> = {},
): EventInput => ({
  role: "tool",
  type: "tool_result",
  ...(callId === undefined ? {} : { callId }),
  ...(output === undefined ? {} : { output }),
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
 * States a lifecycle event of the session, such as a compaction.
 * @param name - The event: `compact`, `clear` or `resume`.
 * @returns The event, to give to `numbered`. It is a system event with `type: "lifecycle"` and the event's name in `name`.
 */
export const lifecyclePart = (name: LifecycleEvent): EventInput => ({
  role: "system",
  type: "lifecycle",
  name,
});

/**
 * States a hook that ran.
 * @param hook - What the stream says of it.
 * @returns The event, to give to `numbered`. It is a system event with `type: "hook"`, which `callsOf` never counts.
 */
export const hookPart = (hook: HookEvent): EventInput => ({
  role: "system",
  type: "hook",
  name: hook.event,
  hook,
});
