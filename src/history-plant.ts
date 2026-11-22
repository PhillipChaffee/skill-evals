import type { Harness, TranscriptEvent } from "./harnesses/shared.js";
import { historyEvents, modeFor, renderPreamble } from "./history.js";
import type { HistoryMode, Seeding } from "./history-types.js";
import { messageOf } from "./scope.js";
import type { Layers } from "./workspace.js";

/** What planting a case's history and sessions left, for the harness to start from. */
export interface Seeded {
  /** The session that the first turn continues, for a history written natively; null otherwise. */
  session: string | null;
  /** The block that goes in front of the first message, for a history in `preamble` mode; null otherwise. */
  preamble: string | null;
  /** The history as transcript events, with `userTurn` -1; empty for a run with no history. */
  events: TranscriptEvent[];
  /** Why planting failed, which makes the run invalid before the harness starts; null when it worked. */
  failure: string | null;
}

/** A run with nothing planted. */
export const UNSEEDED: Seeded = {
  session: null,
  preamble: null,
  events: [],
  failure: null,
};

/**
 * Plants a case's history and prior sessions, after the setup steps and the login files and before the harness starts.
 * Files an adapter writes are in the home when its seed is hashed, so no check reports them as the agent's changes.
 * @param run - The harness, what the case seeds, and the mode that the command forced.
 * @param run.harness - The adapter.
 * @param run.layers - The case's layers; its `history` and `sessions` are planted.
 * @param run.historyMode - `--history-mode`; undefined to take the adapter's own.
 * @param where - The run's home and workspace.
 * @returns What the first turn needs, or `failure` when an adapter could not write what the case seeds. An adapter that
 *   lacks a store is a failure here, which applicability keeps from happening.
 */
export function plantHistory(
  run: {
    harness: Harness;
    layers?: Pick<Layers, "history" | "sessions"> | undefined;
    historyMode?: HistoryMode | undefined;
  },
  where: Seeding,
): Seeded {
  const { harness, layers } = run;
  const { history, sessions } = layers ?? {};
  try {
    if (sessions !== undefined) {
      if (harness.installSessions === undefined) {
        throw new Error(`${harness.id} has no prior-session store`);
      }
      harness.installSessions(sessions, where);
    }
    if (history === undefined) return UNSEEDED;
    const events = historyEvents(history);
    if (modeFor(harness, run.historyMode) === "preamble") {
      return { ...UNSEEDED, preamble: renderPreamble(history), events };
    }
    if (harness.installHistory === undefined) {
      throw new Error(`${harness.id} has no native history store`);
    }
    return {
      ...UNSEEDED,
      session: harness.installHistory(history, where).session,
      events,
    };
  } catch (error) {
    return {
      ...UNSEEDED,
      failure: `could not plant the history: ${messageOf(error)}`,
    };
  }
}
