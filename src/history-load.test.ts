import { expect, test } from "vitest";
import { seededLoad } from "./testing/history-case.js";

const USER = { role: "user", text: "hi" };
const ASSISTANT = { role: "assistant", text: "hello" };
const START = "2026-01-01";
const OWN = { id: "a", startedAt: START, messages: [USER] };

/**
 * Makes an assistant message with one tool call.
 * @param call - The call's keys.
 * @returns The history of that one message.
 */
const calling = (call: unknown) => [{ ...ASSISTANT, toolCalls: [call] }];

test("history.json is strict, and a lenient run does not relax it", () => {
  const bad: [string, unknown, RegExp][] = [
    [
      "an unknown key",
      [{ ...USER, mood: "x" }],
      /\[0\]: unknown key "mood"; allowed: role, text, toolCalls/,
    ],
    [
      "a role",
      [{ ...USER, role: "system" }],
      /"role" must be "user" or "assistant"/,
    ],
    ["an empty list", [], /non-empty list of messages/],
    ["a list that is no list", {}, /non-empty list of messages/],
    [
      "a text that is no string",
      [{ ...USER, text: 3 }],
      /"text" must be a string/,
    ],
    [
      "calls on a user message",
      [{ ...USER, toolCalls: [] }],
      /a user message has no "toolCalls"/,
    ],
    ["a call with no input", calling({ name: "Bash" }), /"input" is missing/],
    [
      "a call with an odd key",
      calling({ name: "Bash", input: 1, out: "" }),
      /toolCalls\[0\]: unknown key "out"/,
    ],
    [
      "a call with no name",
      calling({ name: "", input: 1 }),
      /"name" must be a non-empty string/,
    ],
    [
      "a call output that is no string",
      calling({ name: "B", input: 1, output: 2 }),
      /"output" must be a string/,
    ],
    [
      "toolCalls that is no list",
      [{ ...ASSISTANT, toolCalls: {} }],
      /"toolCalls" must be a list/,
    ],
    ["a call that is no object", calling("Bash"), /must be an object/],
  ];
  for (const [what, history, problem] of bad) {
    expect(() => seededLoad({ history }).load(), what).toThrow(problem);
  }
  const calls = calling({
    name: "Bash",
    input: { command: "ls" },
    output: "a",
  });
  expect(seededLoad({ history: [USER, ...calls] }).load()?.history).toEqual([
    USER,
    ...calls,
  ]);
});

test("sessions.json is strict, and a lenient run does not relax it", () => {
  const bad: [string, unknown, RegExp][] = [
    [
      "a session key",
      [{ ...OWN, extra: 1 }],
      /unknown key "extra"; allowed: id, startedAt, cwd, messages/,
    ],
    [
      "an id that names a path",
      [{ ...OWN, id: "../a" }],
      /"id" must be letters/,
    ],
    [
      "an id that starts with a dot",
      [{ ...OWN, id: ".a" }],
      /"id" must be letters/,
    ],
    [
      "a start that is no date",
      [{ ...OWN, startedAt: "soon" }],
      /"startedAt" must be a date/,
    ],
    ["a cwd that is no string", [{ ...OWN, cwd: 1 }], /"cwd" must be a string/],
    ["a repeated id", [OWN, OWN], /two sessions have the id "a"/],
    ["an empty list", [], /non-empty list of sessions/],
    [
      "a message with an odd key",
      [{ ...OWN, messages: [{ ...USER, x: 1 }] }],
      /messages \[0\]: unknown key "x"/,
    ],
  ];
  for (const [what, sessions, problem] of bad) {
    expect(() => seededLoad({ sessions }).load(), what).toThrow(problem);
  }
  const loaded = seededLoad({ sessions: [{ ...OWN, cwd: "/srv/app" }] }).load();
  expect(loaded?.sessions).toEqual([{ ...OWN, cwd: "/srv/app" }]);
});
