import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import type { RuledCheck } from "./checks/index.js";
import { describeCheck } from "./checks/index.js";
import type { ToolCall } from "./harnesses/shared.js";
import { NOT_REPORTED } from "./harnesses/shared.js";
import { NO_FILES, scoredNow } from "./testing/outcome.js";

const call = (name: string, input: unknown, turn?: number): ToolCall => ({
  name,
  kind: name === "Agent" ? "subagent" : "shell",
  input,
  ...(turn !== undefined && { turn }),
});
const score = (check: Omit<RuledCheck, "weight">, calls: ToolCall[]) =>
  scoredNow(
    { ...check, weight: 1 },
    {
      toolCalls: calls.map((one, index) => ({ ...one, index })),
      finalText: "",
      skillEvents: [],
      loaded: NOT_REPORTED,
      workspace: "",
      ...NO_FILES,
      subject: { dir: null, mutated: [] },
    },
  );
const RESEARCHER = { kind: "subagent", inputMatches: "researcher" } as const;
const SYNTHESIZER = { kind: "subagent", inputMatches: "synthesizer" } as const;

test("a strict sequence quotes the call that breaks the order, however far from the first matches", () => {
  const filler = Array.from({ length: 15 }, (_, n) => call("Bash", { n }));
  const calls = [
    call("Agent", "researcher"),
    call("Agent", "synthesizer"),
    ...filler,
    call("Agent", "researcher"),
  ];
  const verdict = score(
    { type: "tool_order", sequence: [RESEARCHER, SYNTHESIZER], strict: true },
    calls,
  );
  expect(verdict.score).toBe(0);
  expect(verdict.reason).toMatch(
    /sequence\[0\] matches call #17 after call #1/,
  );
  expect(verdict.reason).toContain('#17 t? main subagent Agent "researcher"');
  expect(verdict.reason).toContain("#16 t?");
});

test("sameTurn fails for a match with no turn, unless it is the only match", () => {
  const check = { type: "tool_called", ...RESEARCHER, sameTurn: true } as const;
  const noTurn = call("Agent", "researcher");
  expect(score(check, [noTurn, call("Agent", "researcher")]).score).toBe(0);
  expect(score(check, [call("Agent", "researcher", 1), noTurn]).score).toBe(0);
  expect(score(check, [noTurn]).score).toBe(1);
  const two = [call("Agent", "researcher", 2), call("Agent", "researcher", 2)];
  expect(score({ ...check, min: 2 }, two).score).toBe(1);
  expect(score({ ...check, min: 3 }, two).score).toBe(0);
  expect(score({ ...check, max: 1 }, two).score).toBe(0);
});

test("a pattern with the g flag matches two consecutive calls", () => {
  const calls = [call("Bash", "npm test"), call("Bash", "npm test")];
  const g = { inputMatches: "npm", flags: "g" };
  expect(
    score({ type: "tool_called", kind: "shell", ...g, min: 2 }, calls).score,
  ).toBe(1);
  expect(
    score({ type: "tool_order", sequence: [{ ...g }, { ...g }] }, calls).score,
  ).toBe(1);
  expect(score({ type: "first_tool", matches: g }, calls).score).toBe(1);
  expect(
    score(
      {
        type: "tool_called",
        kind: "shell",
        name: "^Bash$",
        flags: "y",
        min: 2,
      },
      calls,
    ).score,
  ).toBe(1);
});

test("a check names the matchers, counts and options that tell it from another of its type", () => {
  const [loaded] = loadCases(
    path.resolve(import.meta.dirname, "../examples/cases"),
    "first_tool",
  );
  const named = (loaded?.checks ?? [])
    .filter((check) => check.type === "tool_order")
    .map((check) => describeCheck(check));
  expect(named[0]).not.toBe(named[1]);
  expect(named[0]).toContain(
    'before {"kind":"shell","inputMatches":"npm test"}',
  );
  expect(named[1]).toContain('before {"kind":"edit"} (last)');
  expect(named[1]).toContain(
    'after {"kind":"shell","inputMatches":"npm test"} (last)',
  );
  const described = (check: Omit<RuledCheck, "weight">) =>
    describeCheck({ ...check, weight: 1 });
  expect(
    described({
      type: "tool_order",
      sequence: [RESEARCHER, SYNTHESIZER],
      strict: true,
    }),
  ).toBe(
    'tool_order sequence {"kind":"subagent","inputMatches":"researcher"} > {"kind":"subagent","inputMatches":"synthesizer"} strict',
  );
  expect(
    described({
      type: "first_tool",
      matches: RESEARCHER,
      ignoring: [{ kind: "read" }],
    }),
  ).toContain(
    'matches {"kind":"subagent","inputMatches":"researcher"} ignoring {"kind":"read"}',
  );
  expect(
    described({ type: "skill_loaded", anyOf: ["a", "b"], first: true }),
  ).toBe("skill_loaded anyOf a, b first");
  expect(
    described({
      type: "tool_called",
      kind: "edit",
      min: 2,
      max: 3,
      sameTurn: true,
      first: true,
    }),
  ).toBe("tool_called edit min 2 max 3 sameTurn first");
});

test("tool_called and tool_not_called take inputLinesMax", () => {
  const small = call("Edit", { new_string: "a\nb" });
  const big = call("Edit", { new_string: "a\nb\nc\nd" });
  const check = { kind: "shell", inputLinesMax: 2 } as const;
  expect(score({ type: "tool_called", ...check }, [small, big]).score).toBe(1);
  expect(score({ type: "tool_called", ...check }, [big]).score).toBe(0);
  expect(score({ type: "tool_not_called", ...check }, [big]).score).toBe(1);
  expect(score({ type: "tool_not_called", ...check }, [small]).score).toBe(0);
  expect(describeCheck({ type: "tool_called", weight: 1, ...check })).toBe(
    "tool_called shell inputLinesMax 2",
  );
});

test("tool_not_called with inputLinesMin says that no single write was that long", () => {
  const lines = (n: number) => Array.from({ length: n }, () => "x").join("\n");
  const write = (n: number) => ({
    ...call("Write", { file_path: "a.ts", content: lines(n) }),
    kind: "write" as const,
  });
  const none = {
    type: "tool_not_called",
    kind: "write",
    inputLinesMin: 1001,
  } as const;
  expect(score(none, [write(1000), write(10)]).score).toBe(1);
  expect(score(none, [write(10), write(1001)]).score).toBe(0);
  expect(
    score({ type: "tool_called", kind: "write", inputLinesMin: 1001 }, [
      write(1500),
    ]).score,
  ).toBe(1);
  expect(
    score({ type: "tool_called", kind: "write", inputLinesMin: 1001 }, [
      write(5),
    ]).score,
  ).toBe(0);
  expect(describeCheck({ ...none, weight: 1 })).toBe(
    "tool_not_called write inputLinesMin 1001",
  );
  // The other key reads the other way round: it matches the small calls.
  const small = {
    type: "tool_not_called",
    kind: "write",
    inputLinesMax: 1000,
  } as const;
  expect(score(small, [write(1500)]).score).toBe(1);
  expect(score(small, [write(10)]).score).toBe(0);
});
