import { expect, test } from "vitest";
import { applicability } from "./applicability.js";
import type { Case } from "./cases.js";
import type { RuledCheck } from "./checks/index.js";
import { describeCheck } from "./checks/index.js";
import { HARNESSES } from "./harnesses/index.js";
import type { Harness } from "./harnesses/shared.js";
import { NOT_REPORTED } from "./harnesses/shared.js";
import { loadCases } from "./cases.js";
import { plantCase } from "./testing/plant.js";
import { sandbox } from "./testing/sandbox.js";
import { NO_FILES, scoredNow } from "./testing/outcome.js";
import { lines, parseText } from "./testing/streams.js";

const FORTY_SECONDS = 40_000;
const SLOW_WAIT = lines(
  { type: "step_start" },
  {
    type: "tool_use",
    part: {
      tool: "bash",
      callID: "1",
      state: {
        status: "completed",
        input: { command: "sleep 40" },
        output: "",
        time: { start: 1_000, end: 1_000 + FORTY_SECONDS },
      },
    },
  },
  {
    type: "step_finish",
    part: { tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } },
  },
);

const score = (check: Omit<RuledCheck, "weight">) => {
  const parsed = parseText("opencode", SLOW_WAIT);
  return scoredNow(
    { ...check, weight: 1 },
    {
      toolCalls: parsed.toolCalls.map((one, index) => ({ ...one, index })),
      finalText: "",
      skillEvents: [],
      loaded: NOT_REPORTED,
      workspace: "",
      ...NO_FILES,
      subject: { dir: null, mutated: [] },
    },
  );
};

test("a 40-second wait fails tool_not_called with minDurationMs 35000 and passes with 50000", () => {
  expect(
    score({ type: "tool_not_called", kind: "shell", minDurationMs: 35_000 })
      .score,
  ).toBe(0);
  expect(
    score({ type: "tool_not_called", kind: "shell", minDurationMs: 50_000 })
      .score,
  ).toBe(1);
  expect(
    score({ type: "tool_called", name: "bash", maxDurationMs: 30_000 }).score,
  ).toBe(0);
  expect(
    score({ type: "tool_called", name: "bash", maxDurationMs: 45_000 }).score,
  ).toBe(1);
});

test("a call with no duration never fits a duration bound", () => {
  const parsed = parseText(
    "opencode",
    lines({ type: "tool_use", part: { tool: "bash", state: { input: {} } } }),
  );
  expect(parsed.toolCalls[0]?.durationMs).toBeUndefined();
});

test("the duration keys work in a matcher too, and need toolDurations", () => {
  const check = {
    type: "first_tool",
    matches: { kind: "shell", minDurationMs: 35_000 },
  } as const;
  expect(score(check).score).toBe(1);
  const forCase = (id: string) =>
    applicability(
      HARNESSES.find((h) => h.id === id) as Harness,
      {
        checks: [{ ...check, weight: 1 }],
        requires: [],
        harnesses: undefined,
      } as unknown as Case,
      new Set(),
    );
  expect(forCase("opencode")).toMatchObject({ applicable: true });
  expect(forCase("claude-code")).toMatchObject({
    applicable: false,
    missing: ["toolDurations"],
  });
});

test("tool_called and tool_not_called with a duration key need toolDurations, and a plain one does not", () => {
  const needs = (check: object) =>
    applicability(
      HARNESSES.find((h) => h.id === "claude-code") as Harness,
      { checks: [{ weight: 1, ...check }], requires: [] } as unknown as Case,
      new Set(),
    );
  expect(
    needs({ type: "tool_not_called", kind: "shell", minDurationMs: 35_000 }),
  ).toMatchObject({ applicable: false, missing: ["toolDurations"] });
  expect(
    needs({
      type: "tool_order",
      before: { kind: "shell", maxDurationMs: 5 },
      after: { kind: "read" },
    }),
  ).toMatchObject({ applicable: false });
  expect(needs({ type: "tool_not_called", kind: "shell" })).toMatchObject({
    applicable: true,
  });
});

test("the duration keys are positive integers and min may not exceed max, on a check and on a matcher", () => {
  const load = (check: object) => () => {
    loadCases(plantCase(sandbox(), [check]));
  };
  expect(
    load({ type: "tool_called", kind: "shell", minDurationMs: 0 }),
  ).toThrow(/minDurationMs must be a positive integer/);
  expect(
    load({ type: "tool_called", kind: "shell", maxDurationMs: 1.5 }),
  ).toThrow(/maxDurationMs must be a positive integer/);
  const above = /"minDurationMs" 5 is above "maxDurationMs" 3/;
  expect(
    load({
      type: "tool_called",
      kind: "shell",
      minDurationMs: 5,
      maxDurationMs: 3,
    }),
  ).toThrow(above);
  expect(
    load({
      type: "tool_not_called",
      kind: "shell",
      minDurationMs: 5,
      maxDurationMs: 3,
    }),
  ).toThrow(above);
  expect(
    load({
      type: "first_tool",
      matches: { kind: "shell", minDurationMs: 5, maxDurationMs: 3 },
    }),
  ).toThrow(above);
});

test("describeCheck shows the duration keys", () => {
  expect(
    describeCheck({
      type: "tool_not_called",
      kind: "shell",
      minDurationMs: 35_000,
      maxDurationMs: 90_000,
      weight: 1,
    }),
  ).toBe("tool_not_called shell minDurationMs 35000 maxDurationMs 90000");
});
