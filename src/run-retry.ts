import type { Gate } from "./gate.js";
import type { RunRecord } from "./run.js";
import { runAttempt } from "./run.js";
import type { RunPlan } from "./run-plan.js";

/**
 * How long a rate-limited run waits before its next attempt, for each attempt it has made: the wait is this times the
 * number of the attempt that failed. A crash or a timeout is tried again at once.
 */
export const RATE_LIMIT_BACKOFF_MS = 30_000;

/** How a run is retried. */
export interface RetryOptions {
  /** The most attempts after the first. */
  retries: number;
  /** The gate, asked before each retry; every attempt's cost is added to it. */
  gate: Gate;
  /** The wait after a rate limit, per attempt, in milliseconds. Default: `RATE_LIMIT_BACKOFF_MS`. */
  backoffMs?: number | undefined;
}

/**
 * Waits.
 * @param ms - How long to wait, in milliseconds.
 * @returns Resolves when the time has passed.
 */
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Makes a run, and makes it again when it failed for a reason that is not the agent's: a harness crash, a rate limit,
 * or a timeout before the harness wrote anything. The gate is asked before each retry; once a limit is reached the
 * failed attempt stands. Every attempt is paid for in the gate, whether or not it is kept.
 * @param plan - The run to make.
 * @param options - The most retries, the gate that may stop them, and the wait after a rate limit.
 * @returns The last attempt's record, with `attempts` naming the error of each earlier one when there were any, and the
 *   number of that attempt, from 1.
 */
export async function runWithRetries(
  plan: RunPlan,
  options: RetryOptions,
): Promise<{ record: RunRecord; attempt: number }> {
  const { retries, gate, backoffMs = RATE_LIMIT_BACKOFF_MS } = options;
  const earlier: { error: string }[] = [];
  for (let attempt = 1; ; attempt += 1) {
    const { record, retry } = await runAttempt(plan);
    gate.add(record);
    const again = retry !== null && attempt <= retries;
    if (again && retry === "rate limit") await pause(backoffMs * attempt);
    if (!again || gate.check() === "stop") {
      return {
        record: earlier.length > 0 ? { ...record, attempts: earlier } : record,
        attempt,
      };
    }
    earlier.push({ error: record.error as string });
  }
}
