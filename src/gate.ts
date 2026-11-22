import type { RunRecord } from "./run.js";

/** Why a command stopped starting runs: its cost limit or its time limit. */
export type StopReason = "budget" | "duration";

/** The limits of one command. A limit that is not set is undefined. */
export interface Limits {
  /** Tries after the first, for a run that failed for a reason that is not the agent's. */
  retries: number;
  /** The most the command may spend, in US dollars: agent, judge and decision model, over the attempts it made. */
  maxCost: number | undefined;
  /** The longest the command may run, in milliseconds. */
  maxDurationMs: number | undefined;
}

/** What the command has used, and whether it may start more. */
export interface Gate {
  /**
   * Asked before each launch and before each retry. Once it says "stop" it says "stop" again: a limit that was reached
   * stays reached.
   * @returns "stop" when the summed cost is at or above `maxCost`, or the elapsed time is at or above `maxDuration`.
   */
  check: () => "go" | "stop";
  /**
   * Tells whether a limit is reached now, without stopping anything.
   * @returns The reason, cost first; null when neither is.
   */
  reached: () => StopReason | null;
  /** The reason `check` said "stop" with; null while it has not. */
  stopped: () => StopReason | null;
  /** Adds what one finished attempt cost. A cost that the harness did not report adds nothing. */
  add: (attempt: Pick<RunRecord, "costUsd" | "judge" | "decision">) => void;
  /** The summed cost; null while no attempt has reported one. */
  spent: () => number | null;
}

/**
 * Makes the gate of a command.
 * @param limits - The cost and time limits.
 * @param clock - The time in milliseconds. Default: the system clock.
 * @returns The gate, which starts its timer now.
 */
export function createGate(
  limits: Pick<Limits, "maxCost" | "maxDurationMs">,
  clock: () => number = Date.now,
): Gate {
  const started = clock();
  let spent: number | null = null;
  let stopped: StopReason | null = null;
  const reached = (): StopReason | null => {
    if (limits.maxCost !== undefined && (spent ?? 0) >= limits.maxCost) {
      return "budget";
    }
    return limits.maxDurationMs !== undefined &&
      clock() - started >= limits.maxDurationMs
      ? "duration"
      : null;
  };
  return {
    check: () => {
      stopped ??= reached();
      return stopped === null ? "go" : "stop";
    },
    reached,
    stopped: () => stopped,
    add: (attempt) => {
      const costs = [
        attempt.costUsd,
        attempt.judge?.costUsd,
        attempt.decision?.costUsd,
      ];
      for (const cost of costs) {
        if (typeof cost === "number") spent = (spent ?? 0) + cost;
      }
    },
    spent: () => spent,
  };
}
