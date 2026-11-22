import { expect, test } from "vitest";
import { readCheck } from "./checks/index.js";
import type { Scope } from "./checks/transcript-slice.js";
import type { Given } from "./testing/outcome.js";
import { scored } from "./testing/outcome.js";
import { call, played, result } from "./testing/transcript.js";
import { slice } from "./checks/transcript-slice.js";
import { textPart } from "./transcript.js";

const FIRST_WORDS = "I will change the timeout fallback, the smallest fix.";
const FIX_WORDS = "I will fix it";
const RAN_INPUT = "ran-input";
const RAN_OUTPUT = "ran-output";
const BASH = "Bash";
const EDIT = { kind: "edit" } as const;

// Skill, Read, then the first words, then the edit: the first action of this kit is a tool call.
const restates = played(
  textPart("  "),
  call("Skill", { skill: "bug-fix" }, "a"),
  result("a", "loaded"),
  call("Read", { file_path: "src/config.js" }, "b"),
  result("b", "const timeout = 0"),
  textPart(FIRST_WORDS),
  call("Edit", { file_path: "src/config.js" }, "c"),
  result("c", "ok"),
  textPart("Done."),
);

test("the first assistant message restates the goal: the matching pattern scores 1, another 0", () => {
  const check = {
    type: "transcript_matches",
    pattern: "timeout fallback",
    scope: "first_message",
  } as const;
  expect(scored(check, restates).score).toBe(1);
  const missing = scored({ ...check, pattern: "unrelated" }, restates);
  expect(missing.score).toBe(0);
  expect(missing.reason).toContain("#5 text I will change the timeout");
  expect(
    scored(
      { ...check, type: "transcript_lacks", pattern: "unrelated" },
      restates,
    ).score,
  ).toBe(1);
  const found = scored({ ...check, type: "transcript_lacks" }, restates);
  expect(found.score).toBe(0);
  expect(found.reason).toContain("#5 text I will change");
});

test("the first text comes after a Skill call and a Read call and still counts", () => {
  const check = {
    type: "transcript_matches",
    pattern: "^I will",
    scope: "first_message",
  } as const;
  expect(scored(check, restates).score).toBe(1);
  // An empty first text is not the first message, and neither is "Done." for a later one.
  expect(scored({ ...check, pattern: "^Done" }, restates).score).toBe(0);
});

test("a first text that comes after the first edit fails the bounded form", () => {
  const late = played(
    call("Edit", { file_path: "a" }, "a"),
    result("a", "ok"),
    textPart(FIX_WORDS),
  );
  const check = {
    type: "transcript_matches",
    pattern: "I will",
    scope: { first_message: true, before: EDIT },
  } as const;
  const verdict = scored(check, late);
  expect(verdict.score).toBe(0);
  expect(verdict.reason).toContain("comes after the first call");
  expect(verdict.reason).toContain("#2 text I will fix it");
  // The text of `restates` comes after its Read call and before its Edit call.
  expect(scored(check, restates).score).toBe(1);
  const afterRead = {
    ...check,
    scope: { first_message: true, before: { kind: "read" } },
  } as const;
  expect(scored(afterRead, restates).score).toBe(0);
  const early = played(
    textPart(FIX_WORDS),
    call("Edit", { file_path: "a" }, "a"),
  );
  expect(scored(check, early).score).toBe(1);
  expect(scored({ ...check, pattern: "nope" }, early).score).toBe(0);
  // A matcher that matches no call leaves the text before it, so the text is tested.
  const never = played(textPart(FIX_WORDS));
  expect(scored(check, never).score).toBe(1);
});

test("final_message is the last non-empty text; no text at all scores 0 with a reason", () => {
  const check = {
    type: "transcript_matches",
    pattern: "^Done",
    scope: "final_message",
  } as const;
  const trailing = played(textPart("Done."), textPart("   "));
  expect(scored(check, trailing).score).toBe(1);
  expect(scored({ ...check, pattern: "^Other" }, trailing).score).toBe(0);
  const silent = played(call(BASH, { command: "ls" }, "a"));
  for (const type of ["transcript_matches", "transcript_lacks"] as const) {
    const verdict = scored({ ...check, type }, silent);
    expect(verdict.score).toBe(0);
    expect(verdict.reason).toMatch(/no assistant text/);
  }
});

test("scope before and after cut at the first match, and no match scores 0 naming the matcher", () => {
  const events = played(
    textPart("alpha"),
    call("Edit", { file_path: "one" }, "a"),
    textPart("beta"),
    call("Edit", { file_path: "two" }, "b"),
    textPart("gamma"),
  );
  const at = (pattern: string, scope: Scope) =>
    scored({ type: "transcript_matches", pattern, scope }, events).score;
  expect(at("alpha", { before: EDIT })).toBe(1);
  expect(at("beta", { before: EDIT })).toBe(0);
  expect(at("beta", { after: EDIT })).toBe(1);
  expect(at("alpha", { after: EDIT })).toBe(0);
  const none = scored(
    {
      type: "transcript_matches",
      pattern: "alpha",
      scope: { before: { kind: "web" } },
    },
    events,
  );
  expect(none.score).toBe(0);
  expect(none.reason).toContain('no call matches {"kind":"web"}');
  const lacks = scored(
    {
      type: "transcript_lacks",
      pattern: "zzz",
      scope: { after: { kind: "web" } },
    },
    events,
  );
  expect(lacks.score).toBe(0);
});

test("where picks the text: assistant text, tool inputs, tool outputs, or all of them", () => {
  const events = played(
    textPart("said"),
    call(BASH, { command: `echo ${RAN_INPUT}` }, "a"),
    result("a", RAN_OUTPUT),
    call(BASH, { command: "ls" }, "b"),
  );
  const found = (pattern: string, where?: Given["where"]) =>
    scored(
      {
        type: "transcript_matches",
        pattern,
        ...(where ? { where } : {}),
      },
      events,
    ).score;
  expect(found("said")).toBe(1);
  expect(found(RAN_INPUT)).toBe(0);
  expect(found(RAN_INPUT, "tool_input")).toBe(1);
  expect(found('"command"', "tool_input")).toBe(1);
  expect(found(RAN_OUTPUT, "tool_output")).toBe(1);
  expect(found("said", "tool_output")).toBe(0);
  for (const word of ["said", RAN_INPUT, RAN_OUTPUT]) {
    expect(found(word, "all"), word).toBe(1);
  }
  expect(found("absent", "all")).toBe(0);
});

test("patterns see at most the first million characters of one event, and flags g and y are reset", () => {
  const long = `${"a".repeat(1_000_000)}TAIL`;
  const events = played(textPart(long), textPart("TAIL first"));
  const check = {
    type: "transcript_matches",
    pattern: "TAIL",
    scope: "first_message",
  } as const;
  expect(scored(check, events).score).toBe(0);
  expect(scored({ ...check, scope: "final_message" }, events).score).toBe(1);
  const head = played(textPart(`TAIL${"a".repeat(2_000_000)}`));
  expect(scored(check, head).score).toBe(1);
  const twice = played(textPart("ab"), textPart("ab"));
  const sticky = scored(
    { type: "transcript_lacks", pattern: "ab", flags: "g" },
    twice,
  );
  expect(sticky.reason).toContain("#0 text ab");
  expect(sticky.reason).toContain("#1 text ab");
  expect(
    scored({ type: "transcript_lacks", pattern: "^ab", flags: "y" }, twice)
      .reason,
  ).toContain("#1 text ab");
});

test("a failing reason quotes events by index, type and the first 120 characters", () => {
  const events = played(textPart("x".repeat(200)));
  const verdict = scored(
    { type: "transcript_matches", pattern: "nope" },
    events,
  );
  expect(verdict.reason).toContain(`#0 text ${"x".repeat(120)}`);
  expect(verdict.reason).not.toContain("x".repeat(121));
  const many = played(
    ...Array.from({ length: 9 }, (_, n) => textPart(`t${String(n)}`)),
  );
  const lacks = scored({ type: "transcript_lacks", pattern: "t" }, many);
  expect(lacks.reason).toContain("... 4 more");
});

test("a bad by is rejected, in every mode", () => {
  for (const type of ["transcript_matches", "transcript_lacks"]) {
    for (const lenient of [false, true]) {
      expect(() =>
        readCheck({ type, pattern: "a", by: "child" }, "case.json", {
          lenient,
        }),
      ).toThrow(/"by" must be one of/);
    }
  }
});

test("scope loads strictly", () => {
  const load = (scope: unknown) =>
    readCheck(
      { type: "transcript_matches", pattern: "a", scope },
      "case.json",
      { lenient: false },
    );
  expect(load("first_message")).toMatchObject({ scope: "first_message" });
  expect(load({ before: { kind: "edit" } })).toMatchObject({
    scope: { before: { kind: "edit" } },
  });
  expect(load({ first_message: true, before: { kind: "edit" } })).toBeTruthy();
  for (const bad of [
    "sometimes",
    7,
    null,
    [],
    {},
    { before: { kind: "edit" }, after: { kind: "edit" } },
    { before: { kind: "edit" }, extra: 1 },
    { first_message: true },
    { first_message: false, before: { kind: "edit" } },
    { first_message: true, after: { kind: "edit" } },
    { before: { by: {} } },
    { before: "edit" },
  ]) {
    expect(() => load(bad), JSON.stringify(bad)).toThrow(/scope/);
  }
});

test("slice gives the texts to test, and none when the scope cannot be applied", () => {
  const { transcript } = restates;
  expect(slice(transcript, "first_message", "assistant_text")).toEqual([
    FIRST_WORDS,
  ]);
  expect(slice(transcript, "final_message", "assistant_text")).toEqual([
    "Done.",
  ]);
  expect(slice(transcript, { after: EDIT }, "assistant_text")).toEqual([
    "Done.",
  ]);
  expect(slice(transcript, { before: { kind: "web" } }, "all")).toEqual([]);
});

test("transcript_lacks fails when the run has no events of its where, and passes an empty window after a found cut", () => {
  const lacks = (
    scope: Scope | undefined,
    where: Given["where"],
    run = restates,
  ) =>
    scored(
      {
        type: "transcript_lacks",
        pattern: "zzz",
        ...(scope ? { scope } : {}),
        ...(where ? { where } : {}),
      },
      run,
    );
  const silent = played(call(BASH, { command: "ls" }, "a"));
  expect(lacks(undefined, undefined, silent).reason).toBe(
    "the run has no assistant_text text to test",
  );
  expect(lacks(undefined, "tool_output", silent).reason).toBe(
    "the run has no tool_output text to test",
  );
  expect(lacks(undefined, "tool_input", played(textPart("x"))).score).toBe(0);
  expect(lacks(undefined, "all", played()).score).toBe(0);
  const ends = played(textPart("x"), call(BASH, { command: "ls" }, "a"));
  expect(lacks({ after: { kind: "shell" } }, "all", ends).score).toBe(1);
  expect(lacks({ after: { kind: "web" } }, "all", ends).score).toBe(0);
  expect(lacks(undefined, undefined).score).toBe(1);
});
