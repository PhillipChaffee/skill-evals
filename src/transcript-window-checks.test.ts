import { expect, test } from "vitest";
import { readCheck } from "./checks/index.js";
import type { Scope } from "./checks/transcript-slice.js";
import { scored } from "./testing/outcome.js";
import { call, played, result } from "./testing/transcript.js";

const BASH = "Bash";
const EDIT = { kind: "edit" } as const;

test("first_message and final_message with another where are a load error", () => {
  const load = (scope: unknown, where: string) =>
    readCheck(
      { type: "transcript_lacks", pattern: "a", scope, where },
      "case.json",
      {
        lenient: false,
      },
    );
  for (const scope of [
    "first_message",
    "final_message",
    { first_message: true, before: EDIT },
  ]) {
    expect(() => load(scope, "tool_input")).toThrow(/read assistant text/);
  }
  for (const scope of [
    "first_message",
    "final_message",
    { first_message: true, before: EDIT },
  ]) {
    expect(() =>
      readCheck(
        { type: "transcript_matches", pattern: "a", scope, where: "all" },
        "case.json",
        { lenient: false },
      ),
    ).toThrow(/read assistant text/);
  }
  expect(load("first_message", "assistant_text")).toBeTruthy();
  expect(load({ before: EDIT }, "all")).toBeTruthy();
});

test("transcript_lacks over tool outputs fails closed for a call with no result in its window", () => {
  const run = played(
    call(BASH, { command: "one" }, "a"),
    call(BASH, { command: "two" }, "b"),
    call("Edit", { file_path: "x" }, "c"),
    result("b", "fine"),
    call(BASH, { command: "three" }, "d"),
    result("d", "fine"),
  );
  const lacks = (scope: Scope, where: "tool_output" | "all") =>
    scored({ type: "transcript_lacks", pattern: "zzz", scope, where }, run);
  const silent = lacks({ before: EDIT }, "tool_output");
  expect(silent.score).toBe(0);
  expect(silent.reason).toBe(
    "call #0 has no output, so it cannot be shown to lack the pattern",
  );
  expect(lacks({ before: EDIT }, "all").score).toBe(0);
  expect(lacks({ after: EDIT }, "tool_output").score).toBe(1);
});

test("transcript_lacks over tool inputs does not need outputs", () => {
  const run = played(
    call(BASH, { command: "one" }, "a"),
    call("Edit", { file_path: "x" }, "b"),
  );
  const lacks = scored(
    {
      type: "transcript_lacks",
      pattern: "zzz",
      where: "tool_input",
      scope: { before: EDIT },
    },
    run,
  );
  expect(lacks.score).toBe(1);
});
