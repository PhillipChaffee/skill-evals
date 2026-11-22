import { expect, test } from "vitest";
import { lines, parseText } from "./testing/streams.js";

const CLAUDE_CODE = "claude-code";
const TOOL_CALL = "tool_call";
const TOOL_RESULT = "tool_result";

const CLAUDE_STREAM = lines(
  {
    type: "assistant",
    message: {
      id: "m1",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "" },
        {
          type: "tool_use",
          id: "t1",
          name: "Bash",
          input: { command: "x" },
        },
        { type: "tool_use", id: "t2", name: "Read", input: {} },
        { type: "tool_use", id: "t3", name: "Read", input: {} },
      ],
    },
  },
  {
    type: "user",
    message: {
      content: [
        {
          type: TOOL_RESULT,
          tool_use_id: "t1",
          content: "plain",
          is_error: true,
        },
        {
          type: TOOL_RESULT,
          tool_use_id: "t2",
          content: [
            { type: "text", text: "a" },
            { type: "image" },
            { type: "text", text: "b" },
          ],
        },
        { type: TOOL_RESULT, tool_use_id: "t3" },
        { type: "text", text: "not a result" },
      ],
    },
  },
  { type: "user", message: { content: "a plain string" } },
  { type: "user" },
);

test("claude-code reads text blocks, string and list results, and error results", () => {
  const parsed = parseText(CLAUDE_CODE, CLAUDE_STREAM);
  expect(
    parsed.transcript.map((e) => [
      e.type,
      e.text ?? e.output,
      e.isError,
      e.turn,
    ]),
  ).toEqual([
    ["text", "first", undefined, 1],
    [TOOL_CALL, undefined, undefined, 1],
    [TOOL_CALL, undefined, undefined, 1],
    [TOOL_CALL, undefined, undefined, 1],
    [TOOL_RESULT, "plain", true, null],
    [TOOL_RESULT, "ab", undefined, null],
    [TOOL_RESULT, "", undefined, null],
  ]);
});

test("codex marks a failing command's result as an error and reads items that are not commands", () => {
  const done = (item: unknown) => ({ type: "item.completed", item });
  const parsed = parseText(
    "codex",
    lines(
      { type: "thread.started", thread_id: "th" },
      done({
        id: "a",
        type: "command_execution",
        command: "false",
        aggregated_output: "no\n",
        exit_code: 1,
      }),
      done({
        id: "b",
        type: "command_execution",
        command: "true",
        exit_code: 0,
      }),
      done({ id: "c", type: "file_change", changes: [] }),
      done({ id: "d", type: "agent_message" }),
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ),
  );
  expect(
    parsed.transcript.map((e) => [e.type, e.output ?? e.text, e.isError]),
  ).toEqual([
    [TOOL_CALL, undefined, undefined],
    [TOOL_RESULT, "no\n", true],
    [TOOL_CALL, undefined, undefined],
    [TOOL_RESULT, "", false],
    [TOOL_CALL, undefined, undefined],
    [TOOL_RESULT, "", false],
  ]);
  expect(parsed.sessionId).toBe("th");
});

test("opencode records a tool's duration and an error, and a tool that has no output yet has no result", () => {
  const use = (part: unknown) => ({ type: "tool_use", part });
  const parsed = parseText(
    "opencode",
    lines(
      { type: "step_start" },
      use({
        tool: "bash",
        callID: "1",
        state: {
          status: "completed",
          input: {},
          output: "ok",
          time: { start: 10, end: 50 },
        },
      }),
      use({
        tool: "bash",
        callID: "2",
        state: { status: "error", input: {}, error: "bad" },
      }),
      use({
        tool: "bash",
        callID: "3",
        state: { status: "running", input: {} },
      }),
      use({ tool: "bash", callID: "4" }),
      {
        type: "step_finish",
        part: { tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } },
      },
    ),
  );
  const results = parsed.transcript.filter((e) => e.type === TOOL_RESULT);
  expect(
    results.map((e) => [e.callId, e.output, e.isError, e.durationMs]),
  ).toEqual([
    ["1", "ok", false, 40],
    ["2", "bad", true, undefined],
  ]);
});

test("pi reads a result's text, its error flag and the text of a finished turn", () => {
  const parsed = parseText(
    "pi",
    lines(
      { type: "session", id: "pi-1" },
      {
        type: "tool_execution_start",
        toolCallId: "c",
        toolName: "bash",
        args: { command: "x" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "bash",
        isError: true,
        result: {
          content: [
            { type: "text", text: "p" },
            { type: "image" },
            { type: "text", text: "q" },
          ],
        },
      },
      { type: "tool_execution_end", toolCallId: "d", toolName: "bash" },
      {
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        },
      },
      {
        type: "turn_end",
        message: { role: "user", content: [{ type: "text", text: "no" }] },
      },
      {
        type: "turn_end",
        message: { role: "assistant", content: [], stopReason: "stop" },
      },
    ),
  );
  expect(
    parsed.transcript.map((e) => [e.type, e.output ?? e.text, e.isError]),
  ).toEqual([
    [TOOL_CALL, undefined, undefined],
    [TOOL_RESULT, "pq", true],
    [TOOL_RESULT, "", false],
    ["text", "done", undefined],
  ]);
  expect(parsed.sessionId).toBe("pi-1");
});

test("cursor reads a completed call's result, and a result with no call that started", () => {
  const parsed = parseText(
    "cursor",
    lines(
      {
        type: TOOL_CALL,
        subtype: "started",
        call_id: "k",
        tool_call: { shellToolCall: { args: { command: "x" } } },
      },
      {
        type: TOOL_CALL,
        subtype: "completed",
        call_id: "k",
        tool_call: {
          shellToolCall: { args: {}, result: { success: { stdout: "o" } } },
        },
      },
      {
        type: TOOL_CALL,
        subtype: "completed",
        call_id: "m",
        tool_call: { function: { name: "fn", arguments: "{}" } },
      },
      { type: "result", subtype: "success", result: "done" },
    ),
  );
  expect(parsed.transcript.map((e) => [e.type, e.name, e.output])).toEqual([
    [TOOL_CALL, "shell", undefined],
    [TOOL_RESULT, "shell", '{"success":{"stdout":"o"}}'],
    [TOOL_RESULT, "fn", ""],
  ]);
});
