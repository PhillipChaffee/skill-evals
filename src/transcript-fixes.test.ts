import { expect, test } from "vitest";
import type { TranscriptEvent } from "./harnesses/shared.js";
import { callsOf, event, failedCalls, numbered } from "./transcript.js";
import { lines, parseText } from "./testing/streams.js";

const CALL = "tool_call";
const RESULT = "tool_result";
const done = (item: unknown) => ({ type: "item.completed", item });
const started = (item: unknown) => ({ type: "item.started", item });
const turnDone = {
  type: "turn.completed",
  usage: { input_tokens: 1, output_tokens: 1 },
};

/**
 * Reduces events to what the tests compare.
 * @param events - A transcript.
 * @returns Type, name, output or text, and the error flag of each event.
 */
const brief = (events: TranscriptEvent[]) =>
  events.map((e) => [e.type, e.name, e.output ?? e.text, e.isError]);

test("pi puts a message's text before its tool events and does not repeat it at the turn's end", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "text", text: "plan" },
      { type: "toolCall", id: "c", name: "bash", arguments: {} },
    ],
    stopReason: "toolUse",
  };
  const parsed = parseText(
    "pi",
    lines(
      { type: "message_end", message },
      { type: "tool_execution_start", toolCallId: "c", toolName: "bash" },
      {
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "bash",
        result: { content: [{ type: "text", text: "out" }] },
      },
      { type: "turn_end", message },
    ),
  );
  expect(parsed.transcript.map((e) => e.type)).toEqual(["text", CALL, RESULT]);
  expect(parsed.finalText).toBe("plan");
});

test("pi gives a result without a result field no output, not an empty one", () => {
  const parsed = parseText(
    "pi",
    lines({ type: "tool_execution_end", toolCallId: "d", toolName: "bash" }),
  );
  const [result] = parsed.transcript;
  expect(result).toBeDefined();
  expect(result && "output" in result).toBe(false);
});

test("codex reads the result and error of a tool item, and invents none for an item that carries none", () => {
  const parsed = parseText(
    "codex",
    lines(
      done({
        id: "a",
        type: "mcp_tool_call",
        server: "s",
        tool: "t",
        status: "completed",
        result: { content: [{ type: "text", text: "fine" }] },
      }),
      done({
        id: "b",
        type: "mcp_tool_call",
        server: "s",
        tool: "t",
        status: "failed",
        error: { message: "boom" },
      }),
      done({
        id: "c",
        type: "mcp_tool_call",
        server: "s",
        tool: "t",
        status: "failed",
      }),
      done({ id: "d", type: "file_change", status: "failed", changes: [] }),
      done({ id: "e", type: "web_search", query: "q" }),
      done({
        id: "f",
        type: "command_execution",
        command: "x",
        status: "failed",
        aggregated_output: "bad",
        exit_code: null,
      }),
      done({ id: "g", type: "command_execution", command: "y" }),
      turnDone,
    ),
  );
  expect(brief(parsed.transcript)).toEqual([
    [CALL, "mcp_tool_call", undefined, undefined],
    [RESULT, "mcp_tool_call", "fine", false],
    [CALL, "mcp_tool_call", undefined, undefined],
    [RESULT, "mcp_tool_call", "boom", true],
    [CALL, "mcp_tool_call", undefined, undefined],
    [CALL, "file_change", undefined, undefined],
    [CALL, "web_search", undefined, undefined],
    [CALL, "command_execution", undefined, undefined],
    [RESULT, "command_execution", "bad", true],
    [CALL, "command_execution", undefined, undefined],
  ]);
});

test("codex reports a command that started and never completed as a call with no result", () => {
  const command = { id: "k", type: "command_execution", command: "sleep 99" };
  const parsed = parseText(
    "codex",
    lines(
      started(command),
      started({ type: "command_execution", command: "no id" }),
      started({ id: "m", type: "agent_message", text: "x" }),
      started({ id: "n", type: "command_execution", command: "z" }),
      done({
        id: "n",
        type: "command_execution",
        command: "z",
        aggregated_output: "ok",
        exit_code: 0,
      }),
    ),
  );
  expect(brief(parsed.transcript)).toEqual([
    [CALL, "command_execution", undefined, undefined],
    [CALL, "command_execution", undefined, undefined],
    [RESULT, "command_execution", "ok", false],
  ]);
  expect(parsed.toolCalls).toHaveLength(2);
});

test("opencode makes one call of a running event and the completed event with its call id", () => {
  const use = (state: unknown, callID = "1") => ({
    type: "tool_use",
    part: { tool: "bash", callID, state },
  });
  const parsed = parseText(
    "opencode",
    lines(
      use({ status: "running", input: { a: 1 } }),
      use({
        status: "completed",
        input: { a: 1 },
        output: "ok",
        time: { start: 5, end: 9 },
      }),
      use(
        {
          status: "completed",
          input: {},
          output: "no end",
          time: { start: 5 },
        },
        "2",
      ),
      use({ status: "completed", input: {}, output: "x" }, ""),
      use({ status: "completed", input: {}, output: "y" }, ""),
    ),
  );
  expect(parsed.toolCalls).toHaveLength(4);
  const results = parsed.transcript.filter((e) => e.type === RESULT);
  expect(results.map((e) => [e.output, e.durationMs])).toEqual([
    ["ok", 4],
    ["no end", undefined],
    ["x", undefined],
    ["y", undefined],
  ]);
});

test("cursor skips a completed event with no tool call or a null one", () => {
  const parsed = parseText(
    "cursor",
    lines(
      { type: CALL, subtype: "completed" },
      { type: CALL, subtype: "completed", tool_call: null },
      {
        type: CALL,
        subtype: "other",
        tool_call: { readToolCall: { args: {} } },
      },
      { type: "result", subtype: "success", result: "x" },
    ),
  );
  expect(parsed.transcript).toEqual([]);
});

test("a text or output that is not a string is coerced and never throws", () => {
  const odd = (value: unknown) =>
    event({ role: "tool", type: RESULT, output: value as string });
  expect(
    odd([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]).output,
  ).toBe("ab");
  expect(odd({ a: 1 }).output).toBe('{"a":1}');
  expect(odd(7).output).toBe("7");
  expect(odd(null).output).toBe("null");
  expect(odd(() => 1).output).toBe("() => 1");
  expect(odd(10n).output).toBe("10");
  expect(odd(10n).bytes).toBe(2);
  expect(
    event({
      role: "assistant",
      type: "text",
      text: { x: 1 } as unknown as string,
    }).text,
  ).toBe('{"x":1}');
  expect(event({ role: "tool", type: RESULT }).output).toBeUndefined();
});

test("a tool result takes the turn of its call, and a result of its own turn keeps it", () => {
  const listed = numbered([
    { role: "assistant", type: CALL, callId: "a", turn: 3 },
    { role: "tool", type: RESULT, callId: "a" },
    { role: "tool", type: RESULT, callId: "a", turn: 9 },
    { role: "tool", type: RESULT },
  ]);
  expect(listed.map((e) => e.turn)).toEqual([3, 3, 9, null]);
});

test("a call and a result with an empty call id are not joined", () => {
  const listed = numbered([
    { role: "assistant", type: CALL, callId: "", name: "x", turn: 1 },
    { role: "tool", type: RESULT, callId: "", isError: true },
  ]);
  expect(listed[1]?.name).toBeUndefined();
  expect(listed[1]?.turn).toBeNull();
  expect(failedCalls(listed).size).toBe(0);
});

test("a call carries the duration of its result", () => {
  const listed = numbered([
    { role: "assistant", type: CALL, callId: "a", name: "x", kind: "shell" },
    { role: "assistant", type: CALL, callId: "b", name: "y", kind: "shell" },
    { role: "tool", type: RESULT, callId: "a", durationMs: 42 },
  ]);
  expect(callsOf(listed).map((c) => c.durationMs)).toEqual([42, undefined]);
});
