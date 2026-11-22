import { afterEach, expect, test, vi } from "vitest";
import { createGate } from "./gate.js";
import type { RunRecord } from "./run.js";
import { runAttempt } from "./run.js";
import { runWithRetries, RATE_LIMIT_BACKOFF_MS } from "./run-retry.js";
import type { RunPlan } from "./run-plan.js";
import type { RetryKind } from "./retry.js";

vi.mock("./run.js", () => ({ runAttempt: vi.fn() }));

const plan = {} as RunPlan;
const LIMITED = "429";
const RATE = "rate limit";
const BACKOFF_MS = 100;

/**
 * Makes the record of an attempt.
 * @param error - Its error; null for a good run.
 * @param costUsd - What it cost.
 * @returns The record, with only the fields the retry loop reads.
 */
const attempted = (error: string | null, costUsd: number | null = null) =>
  ({
    error,
    costUsd,
    durationMs: 7,
    judge: null,
    decision: null,
  }) as unknown as RunRecord;

/**
 * Plays attempts one after another.
 * @param list - The record and retry reason of each.
 */
function attempts(...list: [RunRecord, RetryKind | null][]): void {
  for (const [record, retry] of list) {
    const spend =
      record.costUsd === null
        ? { costUsd: 0, reported: false, unreported: 1 }
        : { costUsd: record.costUsd, reported: true, unreported: 0 };
    vi.mocked(runAttempt).mockResolvedValueOnce({ record, retry, spend });
  }
}

afterEach(() => {
  vi.mocked(runAttempt).mockReset();
  vi.useRealTimers();
});

const open = () => createGate({ maxCost: undefined, maxDurationMs: undefined });

test("a good run is made once, with no attempts field", async () => {
  attempts([attempted(null), null]);
  const done = await runWithRetries(plan, { retries: 3, gate: open() });
  expect(done.attempt).toBe(1);
  expect(done.record).not.toHaveProperty("attempts");
});

test("a run that failed for the agent's reasons is not retried", async () => {
  attempts([attempted("bad"), null]);
  const done = await runWithRetries(plan, { retries: 3, gate: open() });
  expect(done.attempt).toBe(1);
  expect(runAttempt).toHaveBeenCalledTimes(1);
});

test("a crash is retried at once, up to the number of retries, and the last attempt stands with the earlier errors", async () => {
  attempts(
    [attempted("first"), "crash"],
    [attempted("second"), "crash"],
    [attempted("third"), "crash"],
  );
  const done = await runWithRetries(plan, { retries: 2, gate: open() });
  expect(done.attempt).toBe(3);
  expect(done.record.error).toBe("third");
  expect(done.record.attempts).toEqual([
    { error: "first", costUsd: null, durationMs: 7 },
    { error: "second", costUsd: null, durationMs: 7 },
  ]);
});

test("a rate limit waits the backoff times the attempt that failed", async () => {
  vi.useFakeTimers();
  attempts(
    [attempted(LIMITED), RATE],
    [attempted("429 again"), RATE],
    [attempted(null), null],
  );
  const running = runWithRetries(plan, {
    retries: 2,
    gate: open(),
    backoffMs: BACKOFF_MS,
  });
  await vi.advanceTimersByTimeAsync(BACKOFF_MS - 1);
  expect(runAttempt).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(runAttempt).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(BACKOFF_MS * 2 - 1);
  expect(runAttempt).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  const done = await running;
  expect(done.attempt).toBe(3);
  expect(done.record.attempts).toHaveLength(2);
});

test("the default wait is 30 seconds", () => {
  expect(RATE_LIMIT_BACKOFF_MS).toBe(30_000);
});

test("a limit that is reached stops the retries, and every attempt is paid for", async () => {
  const gate = createGate({ maxCost: 1, maxDurationMs: undefined });
  attempts(
    [attempted("boom", 0.75), "crash"],
    [attempted("boom", 0.5), "crash"],
  );
  const done = await runWithRetries(plan, { retries: 5, gate });
  expect(done.attempt).toBe(2);
  expect(gate.spent()).toBe(1.25);
  expect(gate.stopped()).toBe("budget");
  expect(done.record.attempts).toEqual([
    { error: "boom", costUsd: 0.75, durationMs: 7 },
  ]);
});

test("a limit reached before the first retry leaves the failed attempt as the record", async () => {
  const gate = createGate({ maxCost: 1, maxDurationMs: undefined });
  attempts([attempted("boom", 2), "crash"]);
  const done = await runWithRetries(plan, { retries: 5, gate });
  expect(done.attempt).toBe(1);
  expect(done.record).not.toHaveProperty("attempts");
});

test("a limit reached while a rate-limited run waits stops the retry", async () => {
  vi.useFakeTimers();
  const gate = createGate({ maxCost: undefined, maxDurationMs: 50 }, () =>
    Date.now(),
  );
  attempts([attempted(LIMITED), RATE], [attempted(null), null]);
  const running = runWithRetries(plan, {
    retries: 3,
    gate,
    backoffMs: BACKOFF_MS,
  });
  // The gate says go when the wait begins, and stop when it ends, 100 ms later.
  await vi.advanceTimersByTimeAsync(BACKOFF_MS);
  const done = await running;
  expect(runAttempt).toHaveBeenCalledTimes(1);
  expect(done.attempt).toBe(1);
  expect(done.record.error).toBe(LIMITED);
  expect(gate.stopped()).toBe("duration");
});
