import { expect, test } from "vitest";
import type { RuledCheck } from "./checks/index.js";
import { checkScore } from "./checks/index.js";
import { skillsLoaded } from "./skill-loads.js";
import { lines, parse, parseText } from "./testing/streams.js";

const CODEX_STREAM = "codex.stream.jsonl";

test("a skill counts as loaded through the harness's skill tool or a read of its SKILL.md, and through nothing else", () => {
  const loaded = skillsLoaded([
    { name: "Skill", kind: "skill", input: { skill: "magic:bro" } },
    { name: "skill", kind: "skill", input: { id: "how" } },
    { name: "skill", kind: "skill", input: null },
    {
      name: "Read",
      kind: "read",
      input: { file_path: "/kits/k1/skills/why/skill.md" },
    },
    {
      name: "Bash",
      kind: "shell",
      input: { command: "ls skills && cat notes/SKILL.md" },
    },
    {
      name: "Grep",
      kind: "search",
      input: { pattern: "bro", path: "skills/" },
    },
    {
      name: "write",
      kind: "write",
      input: { path: "skill.md", name: "sharpen" },
    },
  ]);
  expect(loaded).toEqual(["bro", "how", "why"]);
});

const TOOL_STREAMS: [string, string][] = [
  ["claude-code", "claude-code-tools.stream.jsonl"],
  ["codex", CODEX_STREAM],
  ["cursor", "cursor.stream.jsonl"],
];
const score = (id: string, name: string, check: Omit<RuledCheck, "weight">) =>
  checkScore(
    { ...check, weight: 1 },
    {
      toolCalls: parse(id, name).toolCalls,
      finalText: "",
      skillsLoaded: [],
      workspace: "",
      subject: { dir: null, mutated: [] },
    },
  ).score;
// The Claude Code stream is a captured run that used every tool below; the kinds it lacks are false in all three.
const CALLED = [
  { kind: "shell", found: [1, 1, 0] },
  { kind: "read", found: [1, 0, 1] },
  { kind: "write", found: [1, 0, 1] },
  { kind: "edit", found: [1, 0, 0] },
  { kind: "web", found: [1, 0, 0] },
  { kind: "subagent", found: [1, 0, 0] },
  { kind: "search", found: [0, 0, 0] },
] as const;

test.each(CALLED)(
  "a tool check finds a $kind call by its neutral kind in every harness",
  ({ kind, found }) => {
    const scores = (type: "tool_called" | "tool_not_called") =>
      TOOL_STREAMS.map(([id, name]) => score(id, name, { type, kind }));
    expect(scores("tool_called")).toEqual(found);
    expect(scores("tool_not_called")).toEqual(found.map((hit) => 1 - hit));
  },
);

test("a tool check finds a call by its native name and by its input", () => {
  const codex = (check: Omit<RuledCheck, "weight">) =>
    score("codex", CODEX_STREAM, check);
  const called = "tool_called";
  const catSkill = "cat .*SKILL\\.md";
  expect(codex({ type: called, name: "^command_execution$" })).toBe(1);
  expect(codex({ type: called, name: "^COMMAND", flags: "i" })).toBe(1);
  expect(codex({ type: called, name: "^Bash$" })).toBe(0);
  expect(codex({ type: called, kind: "shell", inputMatches: catSkill })).toBe(
    1,
  );
  expect(codex({ type: called, kind: "shell", inputMatches: "rm -rf" })).toBe(
    0,
  );
  expect(codex({ type: called, kind: "edit", inputMatches: catSkill })).toBe(0);
  const notCalled = "tool_not_called";
  expect(
    codex({ type: notCalled, kind: "shell", inputMatches: "rm -rf" }),
  ).toBe(1);
});

test("a tool name that an adapter's table lacks, an inherited property name included, has the kind other", () => {
  const stream = (name: string) => ({
    type: "tool_execution_start",
    toolName: name,
    args: {},
  });
  const kinds = parseText(
    "pi",
    lines(...["mcp_lookup", "constructor", "bash"].map(stream)),
  ).toolCalls.map((call) => call.kind);
  expect(kinds).toEqual(["other", "other", "shell"]);
});

test("codex reads every kind of tool item, and no other item, as a tool call", () => {
  const item = (fields: object) => ({ type: "item.completed", item: fields });
  const { toolCalls } = parseText(
    "codex",
    lines(
      item({ type: "file_change", changes: ["a.txt"] }),
      item({ type: "mcp_tool_call", server: "s", tool: "t", arguments: {} }),
      item({ type: "collab_tool_call", tool: "spawn", prompt: "go" }),
      item({ type: "web_search", query: "q" }),
      item({ type: "reasoning", text: "hm" }),
      item({ type: "toString" }),
    ),
  );
  expect(toolCalls).toEqual([
    { name: "file_change", kind: "edit", input: { changes: ["a.txt"] } },
    {
      name: "mcp_tool_call",
      kind: "other",
      input: { server: "s", tool: "t", arguments: {} },
    },
    {
      name: "collab_tool_call",
      kind: "subagent",
      input: { tool: "spawn", prompt: "go" },
    },
    { name: "web_search", kind: "web", input: { query: "q" } },
  ]);
});

test("cursor reads an MCP tool call, whose arguments are JSON text when they parse", () => {
  const call = (body: object) => ({
    type: "tool_call",
    subtype: "started",
    tool_call: body,
  });
  const fn = (args: string) =>
    call({ function: { name: "lookup", arguments: args } });
  const parsed = parseText(
    "cursor",
    lines(
      fn('{"q":1}'),
      fn("not json"),
      { type: "tool_call", subtype: "completed", tool_call: {} },
      { type: "result", subtype: "success", result: "all of it" },
    ),
  );
  expect(parsed.toolCalls).toEqual([
    { name: "lookup", kind: "other", input: { q: 1 } },
    { name: "lookup", kind: "other", input: "not json" },
  ]);
  expect(parsed.finalText, "with no assistant event").toBe("all of it");
  expect(() => parseText("cursor", lines(call({})))).toThrow(TypeError);
});
