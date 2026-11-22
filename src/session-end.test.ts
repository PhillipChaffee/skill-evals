import { expect, test } from "vitest";
import { HARNESSES } from "./harnesses/index.js";
import type { Parsed } from "./harnesses/shared.js";
import { endOf } from "./session-end.js";
import { lines } from "./testing/streams.js";

const byId = (id: string) => HARNESSES.find((harness) => harness.id === id);
const KILLED = { exit: null, signal: "SIGKILL" } as const;
const TIMED_OUT = { kind: "timeout", stopped: false, ...KILLED } as const;
const STOPPED = { kind: null, stopped: true, ...KILLED } as const;
const TIMEOUT = "timed out after 5 s";
const CLAUDE_ID = "claude-code";
const BOOM = "the turn counter failed: boom";
const SCORE = "score" as const;

/**
 * Reads a stream as the harness's adapter does.
 * @param id - The harness.
 * @param events - The events of the stream.
 * @returns The parse, and the text it came from.
 */
function parsedBy(id: string, ...events: object[]) {
  const stdout = lines(...events);
  return { stdout, parsed: byId(id)?.parse(stdout) as Parsed };
}

const textTurn = (id: string, text: string) => ({
  type: "assistant",
  message: { id, content: [{ type: "text", text }] },
});

test("a stream with no ending is excused on a stopped run, and the last main text stands in", () => {
  const { stdout, parsed } = parsedBy(CLAUDE_ID, textTurn("m1", "so far"));
  expect(parsed.unfinished).toBe(true);
  const end = endOf({ parsed, stdout, failure: null, exec: STOPPED });
  expect(end).toMatchObject({ stoppedBy: "maxTurns", error: null });
  expect(end.parsed.finalText).toBe("so far");
});

test("an error the harness reported survives a stop at maxTurns: Claude Code's error result, Pi's error turn", () => {
  const api = parsedBy(CLAUDE_ID, textTurn("m1", "x"), {
    type: "result",
    subtype: "success",
    is_error: true,
    result: "API Error: 500 internal",
  });
  const claude = endOf({ ...api, failure: null, exec: STOPPED });
  expect(claude.error).toBe("API Error: 500 internal");
  // The error text is never an answer.
  expect(claude.parsed.finalText).toBe("");

  const pi = parsedBy("pi", {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "boom",
    },
  });
  expect(endOf({ ...pi, failure: "exit 1: boom", exec: STOPPED }).error).toBe(
    "boom",
  );
});

test("an adapter that cannot read a stream, and a failing turn counter, fail a stopped run", () => {
  const { stdout, parsed } = parsedBy("opencode", textTurn("m1", "x"));
  const broken = {
    ...parsed,
    error: "the opencode adapter could not read the stream: x",
    unfinished: false,
  };
  expect(
    endOf({ parsed: broken, stdout, failure: null, exec: STOPPED }).error,
  ).toMatch(/could not read the stream/);
  const counted = endOf({
    parsed,
    stdout,
    failure: null,
    exec: STOPPED,
    fault: BOOM,
  });
  expect(counted).toMatchObject({
    stoppedBy: "agent",
    error: BOOM,
  });
});

test("Claude Code's own limit is a scored stop even though the process exits 1", () => {
  const { stdout, parsed } = parsedBy(CLAUDE_ID, textTurn("m1", "got far"), {
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
  });
  const end = endOf({
    parsed,
    stdout,
    failure: "exit 1: ",
    exec: { kind: null, stopped: false, exit: 1, signal: null },
  });
  expect(end).toMatchObject({ stoppedBy: "maxTurns", error: null });
  expect(end.parsed.finalText).toBe("got far");
});

test("a timeout is invalid and reads as one, unless the harness reported its own error", () => {
  const cut = parsedBy(CLAUDE_ID, textTurn("m1", "x"));
  expect(endOf({ ...cut, failure: TIMEOUT, exec: TIMED_OUT }).error).toBe(
    TIMEOUT,
  );
  const pi = parsedBy("pi", {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "boom",
    },
  });
  expect(endOf({ ...pi, failure: TIMEOUT, exec: TIMED_OUT }).error).toBe(
    "boom",
  );
});

test('onTimeout "score" still fails a run whose harness reported an error, and a run that did nothing', () => {
  const pi = parsedBy("pi", {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "boom",
    },
  });
  const failed = endOf({
    ...pi,
    failure: TIMEOUT,
    exec: TIMED_OUT,
    onTimeout: SCORE,
  });
  expect(failed).toMatchObject({ stoppedBy: "timeout", error: "boom" });

  const empty = parsedBy(CLAUDE_ID);
  const nothing = endOf({
    ...empty,
    failure: TIMEOUT,
    exec: TIMED_OUT,
    onTimeout: SCORE,
  });
  expect(nothing.error).toBe(
    "timed out after 5 s before the agent did anything",
  );

  const some = parsedBy(CLAUDE_ID, textTurn("m1", "partial"));
  const scored = endOf({
    ...some,
    failure: TIMEOUT,
    exec: TIMED_OUT,
    onTimeout: SCORE,
  });
  expect(scored).toMatchObject({ stoppedBy: "timeout", error: null });
  expect(scored.parsed.finalText).toBe("partial");
});

test("a run that ended by itself keeps the old rule: the stream's error, then the process's", () => {
  const { stdout, parsed } = parsedBy(CLAUDE_ID, textTurn("m1", "x"));
  const alone = { kind: null, stopped: false, exit: 1, signal: null } as const;
  expect(endOf({ parsed, stdout, failure: null, exec: alone })).toMatchObject({
    stoppedBy: "agent",
    error: "no result event",
  });
  expect(
    endOf({ parsed, stdout: "", failure: "exit 1: x", exec: alone }).error,
  ).toBe("exit 1: x");
});

test("every adapter marks a stream with no ending apart from one that reports an error", () => {
  for (const harness of HARNESSES) {
    expect(harness.parse("").unfinished, harness.id).toBe(true);
  }
  const error = byId("opencode")?.parse(
    lines({ type: "error", error: { name: "Boom" } }),
  );
  expect(error).toMatchObject({ error: "Boom", unfinished: false });
  const codex = byId("codex")?.parse(
    lines({ type: "turn.failed", error: { message: "no" } }),
  );
  expect(codex).toMatchObject({ error: "no", unfinished: false });
});

test("Claude Code's own limit excuses exit 1 only: a crash after it is a failure", () => {
  const { stdout, parsed } = parsedBy(CLAUDE_ID, textTurn("m1", "got far"), {
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
  });
  const crashed = {
    kind: null,
    stopped: false,
    exit: null,
    signal: "SIGSEGV",
  } as const;
  const end = endOf({
    parsed,
    stdout,
    failure: "exit SIGSEGV: ",
    exec: crashed,
  });
  expect(end).toMatchObject({ stoppedBy: "maxTurns", error: "exit SIGSEGV: " });
  const code2 = { kind: null, stopped: false, exit: 2, signal: null } as const;
  expect(
    endOf({ parsed, stdout, failure: "exit 2: ", exec: code2 }).error,
  ).toBe("exit 2: ");
});

test("a counter fault during a timeout's drain keeps the run a timeout", () => {
  const { stdout, parsed } = parsedBy(CLAUDE_ID, textTurn("m1", "x"));
  const end = endOf({
    parsed,
    stdout,
    failure: TIMEOUT,
    exec: TIMED_OUT,
    fault: BOOM,
  });
  expect(end).toMatchObject({
    stoppedBy: "timeout",
    error: BOOM,
  });
});
