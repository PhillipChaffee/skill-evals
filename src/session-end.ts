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
 * says `onTimeout: "score"`, provided the agent did something. The stream of such a run has no ending, and that alone
 * is excused: a harness-reported error, an adapter that could not read the stream, and a failing counter all still
 * fail the run. Without a final text the last main-thread assistant text stands in. Its `tokens` and `costUsd` stay
 * null when the harness writes its totals only at the end. A timeout that is not scored reads `timed out after N s`
 * unless the harness reported its own error.
 * @param run - What the process and the parse showed.
 * @param run.parsed - The adapter's reading of the stream.
 * @param run.stdout - What the harness wrote.
 * @param run.failure - Why the process failed, or null.
 * @param run.exec - How the process ended: its `kind` and whether the runner `stopped` it.
 * @param run.onTimeout - What the case does with a timeout; absent is "invalid".
 * @param run.fault - Why the turn counter threw, or null.
 * @returns Who ended the run, its error, and the parse to use.
 */
export function endOf(run: {
  parsed: Parsed;
  stdout: string;
  failure: string | null;
  exec: Pick<ExecResult, "kind" | "stopped">;
  onTimeout?: OnTimeout | undefined;
  fault?: string | null;
}): RunEnd {
  const { parsed, failure } = run;
  const timedOut = run.exec.kind === "timeout";
  const limited = run.exec.stopped || parsed.hitMaxTurns === true;
  // A timeout wins over a stop, whatever the order the process saw them in.
  const stoppedBy: StoppedBy = timedOut
    ? "timeout"
    : limited
      ? "maxTurns"
      : "agent";
  const fail = (error: string | null): RunEnd => ({ stoppedBy, error, parsed });
  // What the harness or the adapter said went wrong; a stream with no ending is not that.
  const reported = parsed.unfinished === true ? null : parsed.error;
  // The runner stopped the process only because its own counter broke, which the agent did not cause.
  if (run.fault) return { stoppedBy: "agent", error: run.fault, parsed };
  if (stoppedBy === "agent") {
    // The harness's own message is the most specific one, but only when it produced a stream at all.
    return fail(
      (run.stdout.trim() && parsed.error) || failure || parsed.error || null,
    );
  }
  if (timedOut && run.onTimeout !== "score") return fail(reported || failure);
  if (reported) return fail(reported);
  if (timedOut && parsed.transcript.length === 0) {
    return fail(`${String(failure)} before the agent did anything`);
  }
  const finalText = parsed.finalText || lastAssistantText(parsed.transcript);
  return { stoppedBy, error: null, parsed: { ...parsed, finalText } };
}
