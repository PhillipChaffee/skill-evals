import type { ExecResult } from "./exec.js";
import type { Parsed } from "./harnesses/shared.js";
import { lastAssistantText } from "./harnesses/shared.js";

/** Who ended a run: the agent itself (or a crash), the runner at the case's turn limit, or the runner at the time limit. */
export type StoppedBy = "agent" | "maxTurns" | "timeout";

/** What a case does with a run that hits its time limit. */
export type OnTimeout = "invalid" | "score";

/** How a run ended, and what is left to read of it. */
export interface RunEnd {
  stoppedBy: StoppedBy;
  /** Why the run failed; null for a run that ended well, and for a run that was stopped to be scored. */
  error: string | null;
  /** The parse of the stream; a stopped run with no final text has the last main-thread assistant text in its place. */
  parsed: Parsed;
}

/**
 * Decides who ended a run and whether it failed.
 * A run stopped at `maxTurns`, by the runner or by the harness's own limit, is scored. So is a timed-out run whose case
 * says `onTimeout: "score"`. The stream of a stopped run is incomplete by design, so its parse is not held to having an
 * ending: its error is dropped, and without a final text the last main-thread assistant text stands in. Its `tokens` and
 * `costUsd` stay null when the harness writes its totals only at the end.
 * @param run - What the process and the parse showed.
 * @param run.parsed - The adapter's reading of the stream.
 * @param run.stdout - What the harness wrote.
 * @param run.failure - Why the process failed, or null.
 * @param run.exec - How the process ended: its `kind` and whether the runner `stopped` it.
 * @param run.onTimeout - What the case does with a timeout; absent is "invalid".
 * @returns Who ended the run, its error, and the parse to use.
 */
export function endOf(run: {
  parsed: Parsed;
  stdout: string;
  failure: string | null;
  exec: Pick<ExecResult, "kind" | "stopped">;
  onTimeout?: OnTimeout | undefined;
}): RunEnd {
  const { parsed, failure } = run;
  const timedOut = run.exec.kind === "timeout";
  const limited = run.exec.stopped || parsed.hitMaxTurns === true;
  // The runner or the harness stopped at the limit, whether or not the process also timed out: a timeout wins.
  const stoppedBy: StoppedBy = timedOut
    ? "timeout"
    : limited
      ? "maxTurns"
      : "agent";
  const scored =
    stoppedBy === "maxTurns" || (timedOut && run.onTimeout === "score");
  if (!scored) {
    // The harness's own message is the most specific one, but only when it produced a stream at all, and a stream that a
    // timeout cut is incomplete, so the timeout is the reason.
    const error =
      (!timedOut && run.stdout.trim() && parsed.error) ||
      failure ||
      parsed.error ||
      null;
    return { stoppedBy, error, parsed };
  }
  const finalText = parsed.finalText || lastAssistantText(parsed.transcript);
  return { stoppedBy, error: null, parsed: { ...parsed, finalText } };
}
