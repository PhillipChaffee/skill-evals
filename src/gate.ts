import type { Usage } from "./run-plan.js";

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

/** What one attempt cost, as far as it reported. */
export interface Spend {
  /** The sum of every cost that the attempt reported: the agent's, and each reply of the judge and the decision model. */
  costUsd: number;
  /** True when at least one cost was reported, so that `costUsd` is a real sum and not a zero for nothing. */
  reported: boolean;
  /** How many costs were not reported: the agent's, and each reply that stated none. */
  unreported: number;
}

/**
 * Adds up what an attempt cost, reply by reply: one reply with no cost does not hide the others.
 * @param agent - The agent's cost; null when the harness stated none.
 * @param replies - Every reply of the judge, and every request to the decision model.
 * @returns The sum of the costs that were reported, and how many were not.
 */
export function spendOf(
  agent: number | null,
  replies: Pick<Usage, "costUsd">[],
): Spend {
  const costs = [agent, ...replies.map((reply) => reply.costUsd)];
  const known = costs.filter((cost) => cost !== null);
  return {
    costUsd: known.reduce((sum, cost) => sum + cost, 0),
    reported: known.length > 0,
    unreported: costs.length - known.length,
  };
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
   * @param pendingUsd - Cost of an attempt that is not added yet, counted as if it were. Default: 0.
   * @returns The reason, cost first; null when neither is.
   */
  reached: (pendingUsd?: number) => StopReason | null;
  /** The reason `check` said "stop" with; null while it has not. */
  stopped: () => StopReason | null;
  /** Adds what one finished attempt cost. A cost that was not reported adds nothing, and is counted by `unreported`. */
  add: (attempt: Spend) => void;
  /** The summed cost; null while no attempt has reported one. */
  spent: () => number | null;
  /** How many costs were not reported, over every attempt: the agent's and each judge reply's. */
  unreported: () => number;
}

/**
 * Makes the gate of a command.
 * @param limits - The cost and time limits.
 * @param clock - The time in milliseconds. Default: the system clock.
 * @param began - The clock reading at which the time limit starts counting. Default: the reading when this is called.
 * @returns A gate with nothing spent, whose time limit is counted from `began`.
 */
export function createGate(
  limits: Pick<Limits, "maxCost" | "maxDurationMs">,
  clock: () => number = Date.now,
  began?: number,
): Gate {
  const started = began ?? clock();
  let spent: number | null = null;
  let missing = 0;
  let stopped: StopReason | null = null;
  const reached = (pendingUsd = 0): StopReason | null => {
    if (
      limits.maxCost !== undefined &&
      (spent ?? 0) + pendingUsd >= limits.maxCost
    ) {
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
      missing += attempt.unreported;
      if (attempt.reported) spent = (spent ?? 0) + attempt.costUsd;
    },
    spent: () => spent,
    unreported: () => missing,
  };
}
