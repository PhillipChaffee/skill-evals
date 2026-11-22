import type { Harness, TurnState } from "./harnesses/shared.js";

/** Counts the turns of a stream as it arrives, and says when a run has gone past its limit. */
export interface TurnWatch {
  /** For `exec`'s `onStdout`: reads whole lines, counts them, and answers "stop" once the turns exceed the limit. */
  onStdout: (chunk: string) => "continue" | "stop";
  /** The main-thread turns begun so far, counting a last line that had no newline. */
  turns: () => number;
}

/**
 * Reads one line of a stream.
 * @param line - A line of standard output.
 * @returns The JSON value it holds; undefined for a line that is not JSON, which is a log line.
 */
function parsedLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * Starts counting the turns of a harness's stream. Chunks are joined into whole lines first, so an adapter never sees a
 * half line. The runner stops the process as turn `maxTurns + 1` begins, so a partial extra turn may be in the
 * transcript; nothing that was seen is cut.
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
  const count = (line: string): void => {
    const value = parsedLine(line);
    if (value !== undefined) countTurns(value, state);
  };
  return {
    onStdout: (chunk) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      lines.forEach(count);
      return maxTurns !== undefined && state.turns > maxTurns
        ? "stop"
        : "continue";
    },
    turns: () => {
      count(pending);
      pending = "";
      return state.turns;
    },
  };
}
