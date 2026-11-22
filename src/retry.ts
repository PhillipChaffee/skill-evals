import type { ExecResult } from "./exec.js";
import type { Harness } from "./harnesses/shared.js";
import type { StoppedBy } from "./session-end.js";

/**
 * Why a failed run is worth trying again: the failure is the infrastructure's, not the agent's.
 * - "crash": the harness exited non-zero or died of a signal and its stream has no final event, or it could not be
 *   started for want of a process or a file descriptor (EAGAIN, EMFILE, ENFILE).
 * - "rate limit": the adapter says the error is a rate limit.
 * - "timeout before first output": the time limit stopped a harness that had produced no agent event.
 */
export type RetryKind = "crash" | "rate limit" | "timeout before first output";

/** How a run ended, as far as the process and its stream show. */
export interface Ending {
  /** The run's error; null for a run that did not fail. */
  error: string | null;
  stoppedBy: StoppedBy;
  /** How many events the adapter read from the stream; 0 when the agent had done nothing. */
  agentEvents: number;
  /** The adapter's `Parsed.unfinished`: the stream ends without the event that closes a run. */
  unfinished: boolean;
  /** Why the runner's turn counter threw, or null. The counter's fault is the runner's, and a retry would repeat it. */
  fault: string | null;
  /** How the process ended; all null for a harness that never started (a failed setup step). */
  exec: Pick<ExecResult, "kind" | "exit" | "signal">;
}

// The errors of a start that failed because the machine was out of processes or descriptors for a moment.
const RESOURCE_LIMITS = /\b(?:EAGAIN|EMFILE|ENFILE)\b/;

/**
 * Decides whether a failed run may be tried again. A failed setup, a precondition, an isolation breach, any other
 * invalid reason, a fault of the turn counter and a low score are never retried.
 * @param harness - The adapter, which may know a rate limit by its error text.
 * @param end - How the run ended.
 * @param record - What the run's record says of what it loaded; a run that loaded outside the subject, or did not load
 *   the subject, would only breach again.
 * @param record.unexpected - What the harness reported that does not come from the subject.
 * @param record.subjectLoaded - Whether the harness reported the subject as loaded.
 * @returns The reason to retry; null when the run must not be retried.
 */
export function retryKind(
  harness: Pick<Harness, "isRateLimit">,
  end: Ending,
  record: { unexpected: string[]; subjectLoaded: boolean | null },
): RetryKind | null {
  const { error, exec } = end;
  const started =
    exec.kind !== null || exec.exit !== null || exec.signal !== null;
  if (error === null || !started || end.fault !== null) return null;
  if (record.unexpected.length > 0 || record.subjectLoaded === false) {
    return null;
  }
  if (exec.kind === "spawn") {
    return RESOURCE_LIMITS.test(error) ? "crash" : null;
  }
  if (end.stoppedBy === "timeout") {
    return end.agentEvents === 0 ? "timeout before first output" : null;
  }
  if (end.stoppedBy !== "agent") return null;
  if (harness.isRateLimit?.(error) === true) return "rate limit";
  const failed =
    (exec.exit !== null && exec.exit !== 0) || exec.signal !== null;
  return end.unfinished && failed ? "crash" : null;
}
