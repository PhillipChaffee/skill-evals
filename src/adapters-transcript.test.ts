import { expect, test } from "vitest";
import { HARNESSES } from "./harnesses/index.js";
import type { Parsed } from "./harnesses/shared.js";
import { callsOf } from "./transcript.js";
import { parse } from "./testing/streams.js";

const CLAUDE_CODE = "claude-code";
const SESSION = "00000000-0000-4000-8000-000000000000";
const MAIN = { id: "main", type: "main", parent: null, depth: 0 };
const SKILL_FILE_HEAD = /^---\ndescription: Restate the last message/;

/**
 * Reduces a transcript to its shape.
 * @param parsed - What an adapter read.
 * @returns The role, type and tool kind of each event.
 */
const shape = (parsed: Parsed) =>
  parsed.transcript.map((e) => [e.role, e.type, e.kind ?? null]);

const CALL = ["assistant", "tool_call"];
const RESULT = ["tool", "tool_result"];
const TEXT = ["assistant", "text", null];
const SHELL = "shell";

const FIXTURES = [
  {
    id: CLAUDE_CODE,
    name: "claude-code.stream.jsonl",
    shape: [[...CALL, "skill"], [...RESULT, "skill"], TEXT],
    session: SESSION,
    output: /^Launching skill: magic:bro$/,
  },
  {
    id: "codex",
    name: "codex.stream.jsonl",
    shape: [[...CALL, SHELL], [...RESULT, SHELL], TEXT],
    session: SESSION,
    output: SKILL_FILE_HEAD,
  },
  {
    id: "opencode",
    name: "opencode.stream.jsonl",
    shape: [[...CALL, "skill"], [...RESULT, "skill"], TEXT],
    session: null,
    output: /^<skill_content name="bro">/,
  },
  {
    id: "pi",
    name: "pi.stream.jsonl",
    shape: [[...CALL, "read"], [...RESULT, "read"], TEXT],
    session: SESSION,
    output: SKILL_FILE_HEAD,
  },
  {
    id: "cursor",
    name: "cursor.stream.jsonl",
    shape: [
      TEXT,
      [...CALL, "read"],
      [...RESULT, "read"],
      TEXT,
      [...CALL, "write"],
      [...RESULT, "write"],
      TEXT,
    ],
    session: null,
    output: /# Project/,
  },
];

test.each(FIXTURES)(
  "$id parses its fixture into the expected transcript",
  (expected) => {
    const parsed = parse(expected.id, expected.name);
    expect(shape(parsed)).toEqual(expected.shape);
    expect(parsed.transcript.map((e) => e.index)).toEqual(
      parsed.transcript.map((_, position) => position),
    );
    expect(parsed.transcript.every((e) => e.userTurn === 0)).toBe(true);
    expect(parsed.transcript.every((e) => e.agent.id === "main")).toBe(true);
    expect(parsed.transcript[0]?.agent).toEqual(MAIN);
    const result = parsed.transcript.find((e) => e.type === "tool_result");
    expect(result?.output).toMatch(expected.output);
    expect(result?.bytes).toBe(Buffer.byteLength(result?.output ?? ""));
    const texts = parsed.transcript.filter((e) => e.type === "text");
    expect(texts.at(-1)?.text).toBe(parsed.finalText);
    expect(parsed.sessionId).toBe(expected.session);
  },
);

test.each(HARNESSES)(
  "the $id adapter's toolCalls equal callsOf of its transcript",
  (harness) => {
    const name = `${harness.id}.stream.jsonl`;
    const parsed = parse(harness.id, name);
    expect(parsed.toolCalls).toEqual(callsOf(parsed.transcript));
    expect(parsed.toolCalls.length).toBeGreaterThan(0);
  },
);

test("every adapter reports no session id for a stream that has none", () => {
  for (const harness of HARNESSES) {
    expect(harness.parse("{}\n").sessionId).toBeNull();
  }
});

test("only the adapters whose fixtures show them declare the transcript capabilities", () => {
  const has = (capability: "assistantText" | "toolOutputs" | "toolDurations") =>
    HARNESSES.filter((h) => h.capabilities.has(capability))
      .map((h) => h.id)
      .sort();
  const four = [CLAUDE_CODE, "codex", "opencode", "pi"];
  expect(has("assistantText")).toEqual(four);
  expect(has("toolOutputs")).toEqual(four);
  expect(has("toolDurations")).toEqual(["opencode"]);
});
