import type { Harness, TurnState } from "./harnesses/shared.js";
import { jsonLine } from "./harnesses/shared.js";
import { messageOf } from "./scope.js";

/** Counts the turns of a stream as it arrives, and says when a run has gone past its limit. */
export interface TurnWatch {
  /** For `exec`'s `onStdout`: reads whole lines, counts them, and answers "stop" once the turns exceed the limit. */
  onStdout: (chunk: string) => "continue" | "stop";
  /** The main-thread turns begun so far, counting a last line that had no newline. */
  turns: () => number;
  /** Why the adapter's counter threw, or null. A counter that throws stops the run, and the run fails with this. */
  fault: () => string | null;
}

/**
 * Starts counting the turns of a harness's stream. Chunks are joined into whole lines first, so an adapter never sees a
 * half line, and a line is read as the adapter's parse reads it (`jsonLine`). The runner stops the process as turn
 * `maxTurns + 1` begins, so a partial extra turn may be in the transcript; nothing that was seen is cut. Counting ends
 * at the stop request: for a run stopped at `maxTurns`, and for an exit that the kill did not end (the process exited
 * or crashed first), the count is the count at that request, and output that arrives after it is not counted. For a
 * timeout there is no request, and the lines read until the process was gone count, the drain included.
 * @param harness - The adapter; one without `countTurns` cannot be watched.
 * @param maxTurns - The most turns the agent may take; absent counts without ever stopping.
 * @returns The watch, or null for a harness that cannot count turns.
 */
export function turnWatch(
  harness: Pick<Harness, "countTurns">,
  maxTurns: number | undefined,
): TurnWatch | null {
  const { countTurns } = harness;
  if (!countTurns) return null;
  const state: TurnState = { turns: 0, seen: new Set() };
  let pending = "";
  let fault: string | null = null;
  const count = (line: string): void => {
    const value = jsonLine(line);
    if (value === undefined || fault !== null) return;
    try {
      countTurns(value, state);
    } catch (error) {
      fault = `the turn counter failed: ${messageOf(error)}`;
    }
  };
  return {
    onStdout: (chunk) => {
      if (!chunk.includes("\n")) {
        pending += chunk;
        return "continue";
      }
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      lines.forEach(count);
      const over = maxTurns !== undefined && state.turns > maxTurns;
      return over || fault !== null ? "stop" : "continue";
    },
    turns: () => {
      count(pending);
      pending = "";
      return state.turns;
    },
    fault: () => fault,
  };
}
