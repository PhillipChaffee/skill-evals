import { expect, test } from "vitest";
import { HARNESSES } from "./harnesses/index.js";
import { NOT_REPORTED } from "./harnesses/shared.js";
import { lines, parse, parseText } from "./testing/streams.js";

const plainWords =
  /^In plain words: it keeps fixing things until they match\.$/;
const CLAUDE_CODE = "claude-code";
const KIT_COPY = "/run/kit-1";
const CODEX_STREAM = "codex.stream.jsonl";
const CURSOR_STREAM = "cursor.stream.jsonl";

// Every stream below was captured from the real CLI, with ids and paths scrubbed. For pi, opencode, and codex the
// CLI was driven by a scripted local model endpoint. cursor.stream.jsonl is the one exception: it is the example
// sequence from Cursor's output-format documentation, because no authenticated Cursor CLI was available.
const STREAMS = [
  {
    id: CLAUDE_CODE,
    name: "claude-code.stream.jsonl",
    finalText: /^A reconciler is a program .* changes nothing\.$/,
    toolCalls: [
      {
        name: "Skill",
        kind: "skill",
        input: {
          skill: "magic:bro",
          args: "The idempotent reconciler converges state.",
        },
        turn: 1,
      },
    ],
    tokens: { input: 4 + 73969 + 16918, output: 378 },
    costUsd: 0.00431269,
    loaded: {
      ...NOT_REPORTED,
      paths: ["/work/kit-9fq1", "/tmp/home-4c1d/.claude/plugins/synced/design"],
      rawSkills: null,
      plugins: [
        { name: "magic", path: "/work/kit-9fq1" },
        {
          name: "design",
          path: "/tmp/home-4c1d/.claude/plugins/synced/design",
        },
      ],
    },
  },
  {
    id: "pi",
    name: "pi.stream.jsonl",
    finalText: plainWords,
    toolCalls: [
      {
        name: "read",
        kind: "read",
        input: { path: "/work/kit-9fq1/skills/bro/SKILL.md" },
        turn: 0,
      },
    ],
    tokens: { input: 2400, output: 68 },
    costUsd: 0,
    loaded: NOT_REPORTED,
  },
  {
    id: "opencode",
    name: "opencode.stream.jsonl",
    finalText: plainWords,
    toolCalls: [
      {
        name: "skill",
        kind: "skill",
        input: { name: "bro" },
        turn: 1,
        durationMs: 16,
      },
    ],
    tokens: { input: 2400, output: 68 },
    costUsd: 0,
    loaded: NOT_REPORTED,
  },
  {
    id: "codex",
    name: CODEX_STREAM,
    finalText: plainWords,
    toolCalls: [
      {
        name: "command_execution",
        kind: "shell",
        input: {
          command:
            "/bin/bash -lc 'cat /tmp/home-4c1d/.codex/plugins/cache/magic-dev/magic/0.2.0/skills/bro/SKILL.md'",
        },
      },
    ],
    tokens: { input: 2400, output: 68 },
    costUsd: null,
    loaded: NOT_REPORTED,
  },
  {
    id: "cursor",
    name: CURSOR_STREAM,
    finalText: /^Done! I've created the summary in summary\.txt$/,
    toolCalls: [
      { name: "read", kind: "read", input: { path: "README.md" } },
      {
        name: "write",
        kind: "write",
        input: {
          path: "summary.txt",
          fileText: "# README Summary\n\nThis project contains...",
          toolCallId: "toolu_vrtx_01Q3VHVnWFSKygaRPT7WDxrv",
        },
      },
    ],
    tokens: null,
    costUsd: null,
    loaded: NOT_REPORTED,
  },
];

test.each(STREAMS)("$id adapter normalizes a successful stream", (expected) => {
  const parsed = parse(expected.id, expected.name);
  expect(parsed.error).toBeNull();
  expect(parsed.finalText).toMatch(expected.finalText);
  expect(parsed.toolCalls).toEqual(expected.toolCalls);
  expect(parsed.tokens).toEqual(expected.tokens);
  expect(parsed.costUsd).toBe(expected.costUsd);
  expect(parsed.loaded).toEqual(expected.loaded);
});

test("claude-code reports the skills it listed at startup, without a plugin prefix", () => {
  const init = {
    type: "system",
    subtype: "init",
    plugins: [],
    skills: ["magic:bro", "greet"],
  };
  const { loaded } = parseText(CLAUDE_CODE, JSON.stringify(init));
  expect(loaded).toEqual({
    ...NOT_REPORTED,
    paths: [],
    plugins: [],
    skills: ["bro", "greet"],
    rawSkills: ["magic:bro", "greet"],
  });
});

test("claude-code reports its plugins with names, and the agents and MCP servers when the init event has them", () => {
  const init = {
    type: "system",
    subtype: "init",
    plugins: [{ name: "kit", path: KIT_COPY }],
    skills: [],
    agents: ["Explore", "kit:reviewer"],
    mcp_servers: [{ name: "db", status: "connected" }],
  };
  const { loaded } = parseText(CLAUDE_CODE, JSON.stringify(init));
  expect(loaded).toMatchObject({
    paths: [KIT_COPY],
    plugins: [{ name: "kit", path: KIT_COPY }],
    agents: ["Explore", "kit:reviewer"],
    mcpServers: ["db"],
    rules: null,
    hooks: null,
  });
});

const FAILURES = [
  {
    id: "pi",
    name: "pi-error.stream.jsonl",
    error: /security token included in the request is invalid/,
  },
  {
    id: "opencode",
    name: "opencode-error.stream.jsonl",
    error: /Unexpected server error/,
  },
  {
    id: "codex",
    name: "codex-error.stream.jsonl",
    error: /^unexpected status 401 Unauthorized/,
  },
];

test.each(FAILURES)(
  "$id adapter reports the harness's own error for a failed stream",
  ({ id, name, error }) => {
    const parsed = parse(id, name);
    expect(parsed.error).toMatch(error);
    expect(parsed.finalText).toBe("");
  },
);

const FAILED_WITHOUT_TEXT: [string, string, string][] = [
  [
    CLAUDE_CODE,
    lines({ type: "result", subtype: "error_max_turns", is_error: true }),
    "error_max_turns",
  ],
  [
    "cursor",
    lines({ type: "result", subtype: "error", is_error: true }),
    "error",
  ],
  [
    "cursor",
    lines({ type: "result", subtype: "error", is_error: true, result: "boom" }),
    "boom",
  ],
  ["codex", lines({ type: "turn.failed" }), "turn failed"],
  ["opencode", lines({ type: "error", error: { name: "Timeout" } }), "Timeout"],
  ["opencode", lines({ type: "error", error: {} }), "error"],
  [
    "pi",
    lines({
      type: "turn_end",
      message: { role: "assistant", stopReason: "aborted" },
    }),
    "aborted",
  ],
];

test.each(FAILED_WITHOUT_TEXT)(
  "the %s adapter names a failure that carries no message of its own: %s",
  (id, stdout, error) => {
    expect(parseText(id, stdout).error).toBe(error);
  },
);

test.each(HARNESSES)(
  "the $id adapter reports an error, not an empty success, when the stream has no terminal event",
  (harness) => {
    expect(harness.parse("warming up\n{ a log line\n").error).toBeTypeOf(
      "string",
    );
  },
);

test("claude-code gives the tool calls of one message.id one turn, and each new id the next", () => {
  const { toolCalls } = parse(CLAUDE_CODE, "claude-code-turns.stream.jsonl");
  expect(toolCalls.map(({ name, turn }) => [name, turn])).toEqual([
    ["Skill", 1],
    ["Agent", 2],
    ["Agent", 2],
    ["Read", 3],
    ["Bash", 4],
    ["Edit", 4],
    ["Agent", 6],
  ]);
  expect(toolCalls.map((call) => call.index)).toEqual(Array(7).fill(undefined));
});

test("claude-code gives every call without a message id a turn of its own", () => {
  const block = { type: "tool_use", name: "Bash", input: {} };
  const { toolCalls } = parseText(
    CLAUDE_CODE,
    lines(
      { type: "assistant", message: { content: [block, block] } },
      { type: "assistant", message: { content: [block] } },
    ),
  );
  expect(toolCalls.map((call) => call.turn)).toEqual([1, 1, 2]);
});

test("claude-code, opencode and pi declare turnGrouping, each with a fixture", () => {
  expect(
    HARNESSES.filter((h) => h.capabilities.has("turnGrouping"))
      .map((h) => h.id)
      .sort(),
  ).toEqual([CLAUDE_CODE, "opencode", "pi"]);
});

test.each([
  ["pi", "pi-turns.stream.jsonl", [0, 0, 1]],
  ["opencode", "opencode-turns.stream.jsonl", [1, 1, 2]],
])(
  "%s puts two calls of one turn together and the next call in a later turn",
  (id, name, turns) => {
    const parsed = parse(id, name);
    expect(parsed.toolCalls.map((call) => call.turn)).toEqual(turns);
    expect(parsed.error).toBeNull();
  },
);
