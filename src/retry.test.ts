import { expect, test } from "vitest";
import { looksRateLimited } from "./harnesses/rate-limit.js";
import type { Ending } from "./retry.js";
import { retryKind } from "./retry.js";

const harness = { isRateLimit: looksRateLimited };
const CLEAN = { isolated: false, unexpected: [], subjectLoaded: true };
const EXITED = { kind: null, exit: 1, signal: null } as const;
const crashed: Ending = {
  error: "no result event",
  stoppedBy: "agent",
  agentEvents: 3,
  unfinished: true,
  fault: null,
  exec: EXITED,
};
const timedOut: Ending = {
  ...crashed,
  stoppedBy: "timeout",
  agentEvents: 0,
  exec: { kind: "timeout", exit: null, signal: "SIGKILL" },
};

test.each([
  ["a non-zero exit with no final event", crashed, "crash"],
  [
    "a signal with no final event",
    { ...crashed, exec: { kind: null, exit: null, signal: "SIGSEGV" } },
    "crash",
  ],
  [
    "a timeout before the agent did anything",
    timedOut,
    "timeout before first output",
  ],
  [
    "an error that the adapter calls a rate limit",
    { ...crashed, error: "429 Too Many Requests", unfinished: false },
    "rate limit",
  ],
  [
    "a start that failed for want of a process",
    {
      ...crashed,
      error: "spawn x EAGAIN",
      exec: { kind: "spawn", exit: null, signal: null },
    },
    "crash",
  ],
  [
    "a start that failed for want of file table entries",
    {
      ...crashed,
      error: "spawn x ENFILE",
      exec: { kind: "spawn", exit: null, signal: null },
    },
    "crash",
  ],
  [
    "a start that failed for want of a descriptor",
    {
      ...crashed,
      error: "spawn x EMFILE",
      exec: { kind: "spawn", exit: null, signal: null },
    },
    "crash",
  ],
])("%s is retried", (_, ending, kind) => {
  expect(retryKind(harness, ending as Ending, CLEAN)).toBe(kind);
});

test.each([
  ["a run that did not fail", { ...crashed, error: null }],
  [
    "a setup failure, where the harness never started",
    { ...crashed, exec: { kind: null, exit: null, signal: null } },
  ],
  ["a timeout after the agent did something", { ...timedOut, agentEvents: 2 }],
  ["a run stopped at maxTurns", { ...crashed, stoppedBy: "maxTurns" }],
  [
    "a fault of the turn counter, which kills the harness and has no final event",
    {
      ...crashed,
      fault: "counter broke",
      exec: { kind: null, exit: null, signal: "SIGKILL" },
    },
  ],
  [
    "an error the harness reported in a final event",
    { ...crashed, unfinished: false },
  ],
  [
    "an exit with code 0 and no final event",
    { ...crashed, exec: { kind: null, exit: 0, signal: null } },
  ],
  [
    "a start that failed for another reason",
    {
      ...crashed,
      error: "spawn x ENOENT",
      exec: { kind: "spawn", exit: null, signal: null },
    },
  ],
])("%s is not retried", (_, ending) => {
  expect(retryKind(harness, ending as Ending, CLEAN)).toBeNull();
});

test.each([
  [
    "loaded something outside the subject",
    {
      isolated: true,
      unexpected: ["/opt/org/plugin"],
      subjectLoaded: true,
    },
  ],
  [
    "did not load the subject",
    { isolated: false, unexpected: [], subjectLoaded: false },
  ],
])(
  "a crash in a run that %s is not retried, because it would breach again",
  (_, record) => {
    expect(retryKind(harness, crashed, record)).toBeNull();
    expect(retryKind(harness, timedOut, record)).toBeNull();
  },
);

test("outside --isolated, what the harness loads besides the subject does not stop a retry", () => {
  const record = {
    isolated: false,
    unexpected: ["/opt/org/plugin"],
    subjectLoaded: true,
  };
  expect(retryKind(harness, crashed, record)).toBe("crash");
});

test("a subject that the harness did not report on is still retried", () => {
  expect(
    retryKind(harness, crashed, {
      isolated: false,
      unexpected: [],
      subjectLoaded: null,
    }),
  ).toBe("crash");
});

test("an adapter with no isRateLimit never retries for a rate limit", () => {
  const ending = {
    ...crashed,
    error: "rate limit exceeded",
    unfinished: false,
  };
  expect(retryKind({}, ending, CLEAN)).toBeNull();
});

test("provider-shaped rate limit and overload text matches", () => {
  for (const text of [
    "rate limit reached",
    "Rate limit exceeded, retry later",
    "rate_limit_error",
    "529 overloaded_error",
    "overloaded_error: Overloaded",
    "429 Too Many Requests",
    "status: 429",
    "status 529",
    "HTTP 429",
    "API Error: 429 rate_limit_error",
    "API Error: 529 Overloaded",
    "request failed with HTTP status 429",
  ]) {
    expect(looksRateLimited(text), text).toBe(true);
  }
});

test("a stack position or a module path is not a rate limit", () => {
  for (const text of [
    "exit 1: segmentation fault",
    "took 4290 ms",
    "Error: boom\n    at run (/app/dist/cli.js:429:17)\n    at main (/app/dist/cli.js:529:3)",
    "at file:///usr/lib/node_modules/rate-limit/index.js:429:10",
    "Cannot find module '/srv/rate-limit/dist/rate limit.js'",
    "at /opt/ratelimit/status.js:529:1",
    "TypeError at rate-limiter.ts:429",
  ]) {
    expect(looksRateLimited(text), text).toBe(false);
  }
});
