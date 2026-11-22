import { expect, test } from "vitest";
import { normalizeAgent } from "./agents.js";
import type { AgentRef, ToolCall } from "./harnesses/shared.js";
import { UsageError } from "./scope.js";
import { readCheck } from "./checks/index.js";
import type { Given } from "./testing/outcome.js";
import { bareOutcome, scored } from "./testing/outcome.js";
import {
  CLAUDE_CODE,
  DELEGATE,
  RESEARCHER,
  check,
} from "./testing/attribution.js";
import { lines, parse, parseText } from "./testing/streams.js";

const AGENTS = "claude-code-agents.stream.jsonl";
const SRC_EDIT = "src/";
const GENERAL = "general-purpose";
const SICKO = "comment-sicko";

test("normalizeAgent keeps the part after the last colon", () => {
  expect(normalizeAgent("magic:comment-sicko:comment-sicko")).toBe(SICKO);
  expect(normalizeAgent(SICKO)).toBe(SICKO);
  expect(normalizeAgent("plugin:name")).toBe("name");
});

test("every event and call carries the agent of the call that produced it, and nesting sets depth 2", () => {
  const parsed = parse(CLAUDE_CODE, AGENTS);
  const refs = new Map<string, AgentRef>(
    parsed.transcript.map((one) => [one.agent.id, one.agent]),
  );
  expect(refs.get("main")).toEqual({
    id: "main",
    type: "main",
    parent: null,
    depth: 0,
  });
  expect(refs.get("toolu_dispatch_a")).toEqual({
    id: "toolu_dispatch_a",
    type: RESEARCHER,
    parent: "main",
    depth: 1,
  });
  expect(refs.get("toolu_dispatch_b")).toEqual({
    id: "toolu_dispatch_b",
    type: DELEGATE,
    parent: "main",
    depth: 1,
  });
  expect(refs.get("toolu_dispatch_g")).toEqual({
    id: "toolu_dispatch_g",
    type: GENERAL,
    parent: "toolu_dispatch_b",
    depth: 2,
  });
  const by = (name: string) =>
    parsed.toolCalls
      .filter((call) => call.name === name)
      .map(
        (call) => `${String(call.agent?.type)}:${String(call.agent?.depth)}`,
      );
  expect(by("Agent")).toEqual(["main:0", "main:0", DELEGATE + ":1"]);
  expect(by("Grep")).toEqual(["general-purpose:2"]);
  expect(by("Edit")).toEqual([RESEARCHER + ":1", DELEGATE + ":1"]);
});

test("a dispatch's result belongs to the dispatcher, the child's text to the child, and an unknown parent to an unknown agent", () => {
  const { transcript } = parse(CLAUDE_CODE, AGENTS);
  const result = (id: string) =>
    transcript.find((one) => one.type === "tool_result" && one.callId === id);
  expect(result("toolu_dispatch_a")?.agent.id).toBe("main");
  expect(result("toolu_dispatch_g")?.agent.id).toBe("toolu_dispatch_b");
  expect(result("toolu_a_read")?.agent.id).toBe("toolu_dispatch_a");
  const said = transcript.filter((one) => one.type === "text");
  expect(said.map((one) => `${one.agent.type}: ${String(one.text)}`)).toContain(
    `${GENERAL}: Two callers.`,
  );
  const stray = parseText(
    CLAUDE_CODE,
    lines({
      type: "assistant",
      message: {
        id: "m1",
        content: [{ type: "text", text: "orphan" }],
      },
      parent_tool_use_id: "toolu_nowhere",
    }),
  );
  expect(stray.transcript[0]?.agent).toEqual({
    id: "toolu_nowhere",
    type: "unknown",
    parent: "main",
    depth: 1,
  });
});

test("a read-only agent that edits fails tool_not_called by agent", () => {
  const edit = { type: "tool_not_called", kind: "edit" } as const;
  expect(check({ ...edit, by: { agent: RESEARCHER } }).score).toBe(0);
  expect(
    check({ ...edit, by: { agent: "magic:researcher-mid:researcher-mid" } })
      .score,
  ).toBe(0);
  expect(check({ ...edit, by: "main" }).score).toBe(1);
  expect(check({ ...edit, by: { agent: "grunt" } }).score).toBe(1);
  expect(check({ ...edit, by: { agent: RESEARCHER } }).reason).toContain(
    `${RESEARCHER} edit Edit`,
  );
});

test("the main thread made no source edits and the delegate did", () => {
  const edit = { kind: "edit", inputMatches: SRC_EDIT } as const;
  expect(check({ type: "tool_not_called", ...edit, by: "main" }).score).toBe(1);
  expect(
    check({ type: "tool_called", ...edit, by: { agent: DELEGATE } }).score,
  ).toBe(1);
  expect(check({ type: "tool_called", ...edit, by: "subagent" }).score).toBe(1);
  expect(check({ type: "tool_called", ...edit, by: "main" }).score).toBe(0);
  expect(check({ type: "tool_not_called", ...edit }).score).toBe(0);
});

test("the delegate read the workflow skill first", () => {
  const read = {
    type: "tool_called",
    kind: "read",
    inputMatches: "workflow/SKILL\\.md",
    first: true,
  } as const;
  expect(check({ ...read, by: { agent: DELEGATE } }).score).toBe(1);
  expect(check({ ...read, by: { agent: RESEARCHER } }).score).toBe(0);
  expect(check({ ...read, by: { agent: "grunt" } }).reason).toMatch(
    /made no tool call/,
  );
  expect(check({ ...read }).score).toBe(0);
});

test("the planner made zero tool calls", () => {
  const call = (name: string, agent: AgentRef): ToolCall => ({
    name,
    kind: "read",
    input: {},
    agent,
  });
  const planner: AgentRef = {
    id: "p1",
    type: "research-planner",
    parent: "main",
    depth: 1,
  };
  const main: AgentRef = { id: "main", type: "main", parent: null, depth: 0 };
  const zero: Given = {
    type: "tool_called",
    by: { agent: "research-planner" },
    max: 0,
  };
  expect(
    scored(zero, bareOutcome({ toolCalls: [call("Read", main)] })).score,
  ).toBe(1);
  expect(
    scored(
      zero,
      bareOutcome({ toolCalls: [call("Read", main), call("Read", planner)] }),
    ).score,
  ).toBe(0);
});

test("by alone is a valid tool_called, and a bad by is a load error", () => {
  const load = (by: unknown) =>
    readCheck({ type: "tool_called", by }, "c", { lenient: false });
  expect(load("main")).toMatchObject({ by: "main" });
  expect(load({ agent: "x" })).toMatchObject({ by: { agent: "x" } });
  for (const bad of ["child", { agent: "" }, { agent: "x", y: 1 }, [], 3]) {
    expect(() => load(bad)).toThrow(UsageError);
  }
  expect(() =>
    readCheck({ type: "tool_called", kind: "read", by: "child" }, "c", {
      lenient: false,
    }),
  ).toThrow(/"by" must be/);
});

test("tool_order and first_tool matchers take by", () => {
  expect(
    check({
      type: "tool_order",
      before: { kind: "read", by: { agent: DELEGATE } },
      after: { kind: "edit", by: { agent: DELEGATE } },
    }).score,
  ).toBe(1);
  expect(
    check({
      type: "tool_order",
      before: { kind: "edit", by: { agent: DELEGATE } },
      after: { kind: "read", by: { agent: DELEGATE } },
    }).score,
  ).toBe(0);
  expect(
    check({
      type: "first_tool",
      matches: { kind: "skill", by: "main" },
    }).score,
  ).toBe(1);
  expect(
    check({
      type: "first_tool",
      matches: { kind: "skill", by: "subagent" },
    }).score,
  ).toBe(0);
});
