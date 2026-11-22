import { expect, test } from "vitest";
import { looksRateLimited } from "./harnesses/rate-limit.js";
import type { Ending } from "./retry.js";
import { retryKind } from "./retry.js";

const harness = { isRateLimit: looksRateLimited };
const EXITED = { kind: null, exit: 1, signal: null } as const;
const crashed: Ending = {
  error: "no result event",
  stoppedBy: "agent",
  firstOutputMs: 5,
  unfinished: true,
  exec: EXITED,
};

test.each([
  ["a non-zero exit with no final event", crashed, "crash"],
  [
    "a signal with no final event",
    { ...crashed, exec: { kind: null, exit: null, signal: "SIGSEGV" } },
    "crash",
  ],
  [
    "a timeout before the harness wrote anything",
    {
      ...crashed,
      stoppedBy: "timeout",
      firstOutputMs: null,
      exec: { kind: "timeout", exit: null, signal: "SIGKILL" },
    },
    "timeout before first output",
  ],
  [
    "an error that the adapter calls a rate limit",
    { ...crashed, error: "429 Too Many Requests", unfinished: false },
    "rate limit",
  ],
])("%s is retried", (_, ending, kind) => {
  expect(retryKind(harness, ending as Ending)).toBe(kind);
});

test.each([
  ["a run that did not fail", { ...crashed, error: null }],
  [
    "a setup failure, where the harness never started",
    { ...crashed, exec: { kind: null, exit: null, signal: null } },
  ],
  [
    "a timeout after the harness wrote something",
    {
      ...crashed,
      stoppedBy: "timeout",
      exec: { kind: "timeout", exit: null, signal: "SIGKILL" },
    },
  ],
  ["a run stopped at maxTurns", { ...crashed, stoppedBy: "maxTurns" }],
  [
    "an error the harness reported in a final event",
    { ...crashed, unfinished: false },
  ],
  [
    "an exit with code 0 and no final event",
    { ...crashed, exec: { kind: null, exit: 0, signal: null } },
  ],
  [
    "a start that failed",
    { ...crashed, exec: { kind: "spawn", exit: null, signal: null } },
  ],
])("%s is not retried", (_, ending) => {
  expect(retryKind(harness, ending as Ending)).toBeNull();
});

test("an adapter with no isRateLimit never retries for a rate limit", () => {
  const ending = { ...crashed, error: "rate limit", unfinished: false };
  expect(retryKind({}, ending)).toBeNull();
});

test("the rate limit patterns", () => {
  for (const text of [
    "rate limit reached",
    "rate_limit_error",
    "HTTP 429",
    "529 overloaded_error",
    "Too many requests",
  ]) {
    expect(looksRateLimited(text), text).toBe(true);
  }
  expect(looksRateLimited("exit 1: segmentation fault")).toBe(false);
  expect(looksRateLimited("took 4290 ms")).toBe(false);
});
