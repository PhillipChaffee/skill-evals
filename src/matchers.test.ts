import { expect, test } from "vitest";
import { readField } from "./checks/fields.js";
import type { ToolCall } from "./harnesses/shared.js";
import { matches, parseMatcher, quoteCalls } from "./matchers.js";
import { UsageError } from "./scope.js";

const WHERE = "case.json: checks[0].before";
const call = (
  name: string,
  kind: ToolCall["kind"],
  input: unknown,
): ToolCall => ({ name, kind, input });
const at = (one: ToolCall, more: Partial<ToolCall>): ToolCall => ({
  ...one,
  ...more,
});

test("a matcher reads the keys it knows, with its own flags", () => {
  expect(
    parseMatcher(
      { kind: "shell", name: "^Bash$", inputMatches: "npm test", flags: "i" },
      WHERE,
    ),
  ).toEqual({
    kind: "shell",
    name: "^Bash$",
    inputMatches: "npm test",
    flags: "i",
  });
});

test.each([
  [{}, /needs at least one of "kind", "name", "inputMatches"/],
  [{ flags: "i" }, /needs at least one of/],
  [[], /must be an object/],
  [null, /must be an object/],
  [{ kind: "shell", extra: 1 }, /unknown key "extra" for a matcher; allowed:/],
  [{ kind: "nope" }, /unknown tool kind "nope"/],
  [{ name: "(" }, /Invalid regular expression/],
  [{ name: "a", flags: "zz" }, /Invalid regular expression|flags/],
  [
    { by: { agent: "x" }, kind: "shell" },
    /case.json.*"by" is not yet supported/,
  ],
  [
    { inputLinesMax: 3 },
    /needs at least one of "kind", "name", "inputMatches"/,
  ],
  [
    { inputLinesMax: "3", kind: "shell" },
    /inputLinesMax must be a positive integer/,
  ],
])("a matcher %j is a load error", (raw, message) => {
  expect(() => parseMatcher(raw, WHERE)).toThrow(UsageError);
  expect(() => parseMatcher(raw, WHERE)).toThrow(message);
});

test("a matcher takes the extra keys a field names, and reads them with their types", () => {
  const extras = {
    which: { type: "enum", values: ["first", "last"], meaning: "x" },
  } as const;
  expect(parseMatcher({ kind: "edit", which: "last" }, WHERE, extras)).toEqual({
    kind: "edit",
    which: "last",
  });
  expect(() =>
    parseMatcher({ kind: "edit", which: "x" }, WHERE, extras),
  ).toThrow(/"which" must be "first" or "last"/);
  expect(() => parseMatcher({ kind: "edit", which: "last" }, WHERE)).toThrow(
    /unknown key "which"/,
  );
});

test("the matcher field types are read by parseMatcher once matchers.ts is loaded", () => {
  const at = { where: "f", owner: "a check", siblings: { a: { name: "x" } } };
  const one = { a: { type: "matcher" as const, meaning: "m" } };
  expect(readField(one, "a", at)).toEqual({ name: "x" });
  expect(() =>
    readField(one, "a", { ...at, siblings: { a: { bogus: 1 } } }),
  ).toThrow(/unknown key "bogus"/);
  const many = { a: { type: "matchers" as const, meaning: "m" } };
  expect(
    readField(many, "a", { ...at, siblings: { a: [{ kind: "read" }] } }),
  ).toEqual([{ kind: "read" }]);
  expect(() => readField(many, "a", { ...at, siblings: { a: [] } })).toThrow(
    /non-empty list of matchers/,
  );
  expect(() =>
    readField(many, "a", { ...at, siblings: { a: [{ kind: "read" }, 3] } }),
  ).toThrow(/must be an object/);
});

test("a matcher fits a call by kind, name and input, each with the matcher's own flags", () => {
  const bash = call("Bash", "shell", { command: "npm TEST" });
  expect(matches({ kind: "shell" }, bash)).toBe(true);
  expect(matches({ kind: "edit" }, bash)).toBe(false);
  expect(matches({ name: "^bash$" }, bash)).toBe(false);
  expect(matches({ name: "^bash$", flags: "i" }, bash)).toBe(true);
  expect(matches({ inputMatches: "npm test" }, bash)).toBe(false);
  expect(matches({ inputMatches: "npm test", flags: "i" }, bash)).toBe(true);
  expect(
    matches({ kind: "shell", name: "^Bash$", inputMatches: "TEST" }, bash),
  ).toBe(true);
  expect(matches({ inputMatches: "null" }, call("X", "other", undefined))).toBe(
    true,
  );
});

test("a quote shows one line per call, around the calls that matter", () => {
  const calls = [
    at(call("Read", "read", { file_path: "a" }), { index: 0, turn: 1 }),
    at(call("Bash", "shell", { command: "x".repeat(200) }), {
      index: 1,
      turn: 1,
    }),
    at(call("Agent", "subagent", { subagent_type: "r" }), {
      index: 2,
      turn: 2,
      agent: { id: "a1", type: "researcher", parent: "main", depth: 1 },
    }),
    at(call("Edit", "edit", { file_path: "b" }), { index: 3, turn: 3 }),
    call("Edit", "edit", { file_path: "c" }),
  ];
  const lines = quoteCalls(calls, [2]).split("\n");
  expect(lines).toEqual([
    `#1 t1 main shell Bash {"command":"${"x".repeat(80 - 12)}`,
    '#2 t2 researcher subagent Agent {"subagent_type":"r"}',
    '#3 t3 main edit Edit {"file_path":"b"}',
  ]);
  expect(quoteCalls(calls, [4]).split("\n")).toEqual([
    '#3 t3 main edit Edit {"file_path":"b"}',
    '#4 t? main edit Edit {"file_path":"c"}',
  ]);
});

test("a quote of no anchor shows the start of the list, and says what it left out", () => {
  const calls = Array.from({ length: 15 }, (_, index) =>
    at(call("Bash", "shell", { n: index }), { index }),
  );
  const shown = quoteCalls(calls, []).split("\n");
  expect(shown).toHaveLength(13);
  expect(shown[0]).toBe('#0 t? main shell Bash {"n":0}');
  expect(shown[12]).toBe("... 3 more");
  expect(quoteCalls([], [])).toBe("(no tool calls)");
  expect(quoteCalls(calls, [], 2).split("\n")).toHaveLength(3);
});

test("inputLinesMax counts the lines of the longest string in the input, at any depth", () => {
  const matcher = { kind: "edit", inputLinesMax: 2 } as const;
  const edit = (input: unknown) => call("Edit", "edit", input);
  expect(
    matches(matcher, edit({ file_path: "a.ts", new_string: "a\nb" })),
  ).toBe(true);
  expect(matches(matcher, edit({ new_string: "a\nb\nc" }))).toBe(false);
  expect(
    matches(matcher, edit({ edits: [{ old: "x", new: "a\nb\nc\n" }] })),
  ).toBe(false);
  expect(matches(matcher, edit({ deep: { list: ["short", "p\nq"] } }))).toBe(
    true,
  );
  expect(
    matches(matcher, edit({ path: "a/very/long/path.ts", body: "a\nb\n" })),
  ).toBe(true);
  expect(matches(matcher, edit({ count: 7 }))).toBe(true);
  expect(matches(matcher, edit(null))).toBe(true);
  expect(matches(matcher, edit("one\ntwo\nthree"))).toBe(false);
  expect(matches({ ...matcher, inputLinesMax: 0 }, edit({ text: "" }))).toBe(
    true,
  );
  expect(matches({ kind: "edit" }, edit({ text: "a\nb\nc\nd" }))).toBe(true);
});

test("inputLinesMax reads with its type, beside the other keys", () => {
  expect(parseMatcher({ kind: "edit", inputLinesMax: 3 }, WHERE)).toEqual({
    kind: "edit",
    inputLinesMax: 3,
  });
});
