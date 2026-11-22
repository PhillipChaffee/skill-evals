import { expect, test } from "vitest";
import { CHECKS, describeCheck } from "./checks/index.js";
import { scored } from "./testing/outcome.js";
import { call, played, result } from "./testing/transcript.js";
import { textPart } from "./transcript.js";

const RUN = { kind: "shell", inputMatches: "suite" } as const;
const RUN_SUITE = "sh suite/run.sh";
const PASSED = "all passed";
const GREEN = { which: "first", pattern: "\\bfail", flags: "i" } as const;
const redThenGreen = (fixed: boolean) =>
  played(
    call("Bash", { command: RUN_SUITE }, "a"),
    result("a", "FAIL add(1, 2) = 4\n1 failed"),
    call("Edit", { file_path: "src/add.js" }, "b"),
    result("b", "ok"),
    call("Bash", { command: RUN_SUITE }, "c"),
    result("c", fixed ? PASSED : "1 failed"),
  );

test("red before green: the first run shows a failure and the last shows a pass", () => {
  const events = redThenGreen(true);
  const first = { type: "tool_output_matches", tool: RUN, ...GREEN } as const;
  const last = {
    type: "tool_output_matches",
    tool: RUN,
    which: "last",
    pattern: "\\bpass",
  } as const;
  expect(scored(first, events).score).toBe(1);
  expect(scored(last, events).score).toBe(1);
  expect(scored(last, redThenGreen(false)).score).toBe(0);
  const wrongOrder = played(
    call("Bash", { command: RUN_SUITE }, "a"),
    result("a", PASSED),
  );
  expect(scored(first, wrongOrder).score).toBe(0);
  const claimed = played(
    textPart("All checks pass now."),
    call("Edit", { file_path: "src/add.js" }, "b"),
    result("b", "ok"),
    call("Bash", { command: "true" }, "c"),
    result("c", ""),
  );
  expect(scored(first, claimed).score).toBe(0);
  expect(scored(last, claimed).score).toBe(0);
  expect(scored(last, claimed).reason).toContain("no call matches");
});

test("tool_output_matches any, and a call with no result is not a match", () => {
  const events = played(
    call("Bash", { command: RUN_SUITE }, "a"),
    call("Bash", { command: RUN_SUITE }, "b"),
    result("b", PASSED),
  );
  const any = {
    type: "tool_output_matches",
    tool: RUN,
    pattern: "passed",
  } as const;
  expect(scored(any, events).score).toBe(1);
  expect(scored({ ...any, pattern: "nothing" }, events).score).toBe(0);
  const first = scored({ ...any, which: "first" }, events);
  expect(first.score).toBe(0);
  expect(first.reason).toContain("call #0 has no output");
  expect(scored({ ...any, which: "last" }, events).score).toBe(1);
  const noOutput = played(
    call("Bash", { command: RUN_SUITE }, "a"),
    result("a", undefined),
  );
  expect(scored({ ...any, which: "last" }, noOutput).reason).toContain(
    "call #0 has no output",
  );
  expect(scored(any, noOutput).score).toBe(0);
});

test("tool_output_lacks fails closed for a call with no output", () => {
  const lacks = {
    type: "tool_output_lacks",
    tool: RUN,
    pattern: "fail",
  } as const;
  const clean = played(
    call("Bash", { command: RUN_SUITE }, "a"),
    result("a", PASSED),
  );
  expect(scored(lacks, clean).score).toBe(1);
  expect(scored({ ...lacks, which: "last" }, clean).score).toBe(1);
  const dirty = redThenGreen(true);
  expect(scored(lacks, dirty).score).toBe(0);
  expect(scored({ ...lacks, which: "first" }, dirty).score).toBe(0);
  expect(scored({ ...lacks, which: "last" }, dirty).score).toBe(1);
  const missing = played(
    call("Bash", { command: RUN_SUITE }, "a"),
    call("Bash", { command: RUN_SUITE }, "b"),
    result("b", PASSED),
  );
  for (const which of ["any", "first"] as const) {
    const verdict = scored({ ...lacks, which }, missing);
    expect(verdict.score).toBe(0);
    expect(verdict.reason).toContain(
      "call #0 has no output, so it cannot be shown to lack the pattern",
    );
  }
  expect(scored({ ...lacks, which: "last" }, missing).score).toBe(1);
  const none = scored(lacks, played(textPart("x")));
  expect(none.score).toBe(0);
  expect(none.reason).toContain("no call matches");
});

test("tool_output_size bounds each output and ignores calls with no result", () => {
  const events = played(
    call("Bash", { command: RUN_SUITE }, "a"),
    result("a", "x".repeat(50)),
    call("Read", { file_path: "big" }, "b"),
    result("b", "y".repeat(500)),
    call("Bash", { command: RUN_SUITE }, "c"),
  );
  expect(
    scored({ type: "tool_output_size", maxBytes: 500 }, events).score,
  ).toBe(1);
  const over = scored({ type: "tool_output_size", maxBytes: 499 }, events);
  expect(over.score).toBe(0);
  expect(over.reason).toContain("#3 tool_result yyyy");
  expect(over.reason).toContain("500 bytes");
  expect(
    scored({ type: "tool_output_size", maxBytes: 100, tool: RUN }, events)
      .score,
  ).toBe(1);
  expect(
    scored(
      { type: "tool_output_size", maxBytes: 100, tool: { kind: "read" } },
      events,
    ).score,
  ).toBe(0);
  const multibyte = played(
    call("Bash", { command: "x" }, "a"),
    result("a", "é".repeat(10)),
  );
  expect(
    scored({ type: "tool_output_size", maxBytes: 19 }, multibyte).score,
  ).toBe(0);
});

test("needs follow where and the tool_output checks", () => {
  const needs = (check: Record<string, unknown>) =>
    CHECKS[String(check["type"])]?.needs?.({ weight: 1, ...check } as never);
  const base = { type: "transcript_matches", pattern: "a" };
  expect(needs(base)).toEqual(["assistantText"]);
  expect(needs({ ...base, where: "tool_input" })).toEqual([]);
  expect(needs({ ...base, where: "tool_output" })).toEqual(["toolOutputs"]);
  expect(needs({ ...base, where: "all" })).toEqual(["toolOutputs"]);
  expect(needs({ ...base, scope: { before: { kind: "edit" } } })).toEqual([
    "assistantText",
  ]);
  for (const type of ["tool_output_matches", "tool_output_lacks"]) {
    expect(needs({ type, tool: RUN, pattern: "a" })).toEqual(["toolOutputs"]);
  }
  expect(needs({ type: "tool_output_size", maxBytes: 1 })).toEqual([
    "toolOutputs",
  ]);
});

test("a check names its scope, where, tool and bound", () => {
  const named = (check: Record<string, unknown>) =>
    describeCheck({ weight: 1, ...check } as never);
  expect(
    named({
      type: "transcript_matches",
      pattern: "goal",
      scope: { first_message: true, before: { kind: "edit" } },
      where: "all",
    }),
  ).toBe(
    'transcript_matches /goal/ scope {"first_message":true,"before":{"kind":"edit"}} where all',
  );
  expect(
    named({ type: "transcript_lacks", pattern: "x", scope: "final_message" }),
  ).toBe("transcript_lacks /x/ scope final_message");
  expect(
    named({
      type: "tool_output_matches",
      tool: RUN,
      pattern: "ok",
      which: "last",
    }),
  ).toBe(
    'tool_output_matches /ok/ tool {"kind":"shell","inputMatches":"suite"} which last',
  );
  expect(named({ type: "tool_output_size", maxBytes: 20000 })).toBe(
    "tool_output_size maxBytes 20000",
  );
});
