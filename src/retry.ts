import type { ExecResult } from "./exec.js";
import type { Harness } from "./harnesses/shared.js";
import type { StoppedBy } from "./session-end.js";

/**
 * Why a failed run is worth trying again: the failure is the infrastructure's, not the agent's.
 * - "crash": the harness exited non-zero or died of a signal, and its stream has no final event.
 * - "rate limit": the adapter says the error is a rate limit.
 * - "timeout before first output": the time limit stopped a harness that had written nothing.
 */
export type RetryKind = "crash" | "rate limit" | "timeout before first output";

/** What decides whether a run is retried. */
export interface Ending {
  /** The run's error; null for a run that did not fail. */
  error: string | null;
  stoppedBy: StoppedBy;
  firstOutputMs: number | null;
  /** The adapter's `Parsed.unfinished`: the stream ends without the event that closes a run. */
  unfinished: boolean;
  /** How the process ended; all null for a harness that never started (a failed setup step). */
  exec: Pick<ExecResult, "kind" | "exit" | "signal">;
}

/**
 * Decides whether a failed run may be tried again. A failed setup, a precondition, an isolation breach, any other
 * invalid reason and a low score are never retried: only what is checked here, from how the process ended.
 * @param harness - The adapter, which may know a rate limit by its error text.
 * @param end - How the run ended.
 * @returns The reason to retry; null when the run must not be retried.
 */
export function retryKind(
  harness: Pick<Harness, "isRateLimit">,
  end: Ending,
): RetryKind | null {
  const { error, exec } = end;
  const started =
    exec.kind !== null || exec.exit !== null || exec.signal !== null;
  if (error === null || !started) return null;
  if (end.stoppedBy === "timeout") {
    return end.firstOutputMs === null ? "timeout before first output" : null;
  }
  if (end.stoppedBy !== "agent") return null;
  if (harness.isRateLimit?.(error) === true) return "rate limit";
  const failed =
    (exec.exit !== null && exec.exit !== 0) || exec.signal !== null;
  return end.unfinished && failed ? "crash" : null;
}
