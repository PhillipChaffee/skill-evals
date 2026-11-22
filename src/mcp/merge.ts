import type { AgentRef, Parsed, TranscriptEvent } from "../harnesses/shared.js";
import { withIndexes } from "../harnesses/shared.js";
import { callsOf, event } from "../transcript.js";
import type { McpCall } from "./types.js";

/** The agent of a call that only the mock log shows: which agent made it is unknown. */
const UNKNOWN_AGENT: AgentRef = {
  id: "unknown",
  type: "unknown",
  parent: "main",
  depth: 1,
};

/**
 * Makes the two events of a logged call.
 * @param call - The call the mock server answered.
 * @param at - The call's number, which makes its id.
 * @param after - The event the call goes after, which gives its user turn; absent at the start.
 * @returns A `tool_call` of kind `mcp` and the `tool_result` that answers it, both marked `source: "mock-log"`.
 */
function eventsOf(
  call: McpCall,
  at: number,
  after: TranscriptEvent | undefined,
): TranscriptEvent[] {
  const shared = {
    callId: `mock-log-${String(at)}`,
    agent: UNKNOWN_AGENT,
    userTurn: after?.userTurn ?? 0,
    source: "mock-log" as const,
    at: call.at,
  };
  const name = `${call.server}.${call.tool}`;
  return [
    event({
      ...shared,
      role: "assistant",
      type: "tool_call",
      kind: "mcp",
      name,
      input: call.input,
    }),
    event({
      ...shared,
      role: "tool",
      type: "tool_result",
      kind: "mcp",
      name,
      output: call.response.text,
      isError: call.response.isError,
    }),
  ];
}

/**
 * Finds where a logged call goes among events.
 * @param events - The run's events so far.
 * @param at - When the call was answered, as an ISO time.
 * @returns The position after the last event that states a time up to `at`. When no event states a time, the end: the
 *   stream cannot say where the call belongs, so it goes last.
 */
function positionOf(events: TranscriptEvent[], at: string): number {
  if (!events.some((one) => one.at !== undefined)) return events.length;
  let last = -1;
  events.forEach((one, index) => {
    if (one.at !== undefined && one.at <= at) last = index;
  });
  return last + 1;
}

/**
 * Adds the calls of the mock log to a run whose stream shows none of them.
 * @param parsed - What the adapter read.
 * @param calls - The calls the mock servers logged, in time order.
 * @returns `parsed` itself when the log is empty or the stream already has MCP calls. Otherwise the transcript with each
 *   logged call as a `tool_call` and a `tool_result` marked `source: "mock-log"`, placed by time among the events that
 *   state one and last when none do, and the calls list rebuilt. Their agent is of type `unknown`: the log cannot say
 *   who made them, so a `by` that names a real agent, or `main`, never matches them.
 */
export function mergeMockLog(parsed: Parsed, calls: McpCall[]): Parsed {
  if (
    calls.length === 0 ||
    parsed.transcript.some((one) => one.kind === "mcp")
  ) {
    return parsed;
  }
  let events = parsed.transcript;
  calls.forEach((call, number) => {
    const position = positionOf(events, call.at);
    events = [
      ...events.slice(0, position),
      ...eventsOf(call, number, events[position - 1]),
      ...events.slice(position),
    ];
  });
  const transcript = events.map((one, index): TranscriptEvent => ({
    ...one,
    index,
  }));
  return { ...parsed, transcript, toolCalls: withIndexes(callsOf(transcript)) };
}
