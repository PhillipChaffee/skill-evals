import type { Need } from "./capabilities.js";
import type { Case } from "./cases.js";
import { modeFor } from "./history.js";
import type { Harness } from "./harnesses/shared.js";
import type { HistoryMode } from "./history-types.js";

/** What a case needs from a harness because of its history and sessions. */
export interface HistoryNeeds {
  /** Capabilities the harness must declare. */
  needs: Need[];
  /** Capabilities that the mode of the run can never meet, whatever the adapter declares. */
  blocked: Need[];
}

/**
 * Lists what a case needs because it seeds a history or sessions.
 * @param caseDef - The case, with its history, sessions, `requires` and turns.
 * @param run - The harness and the mode that the command forced.
 * @param run.harness - The adapter, which has a default mode.
 * @param run.forced - `--history-mode`; undefined to take the adapter's own.
 * @returns For a `history.json`: `history` under `preamble` and `historyNative` under `native`. For `sessions/`:
 *   `sessionStore`. Under `preamble`, `blocked` holds `historyNative` when the case lists it in `requires`, and when the
 *   first message is a slash command (an `invoke` turn, or a prompt that starts with `/`), because a block in front of it would stop it being one.
 */
export function historyNeeds(
  caseDef: Pick<Case, "history" | "sessions" | "requires" | "turns" | "prompt">,
  run: {
    harness: Pick<Harness, "historyMode">;
    forced?: HistoryMode | undefined;
  },
): HistoryNeeds {
  const preamble = modeFor(run.harness, run.forced) === "preamble";
  const first = caseDef.turns?.[0];
  // What the user's first message is: a prompt's text, or null for an invocation, an event or a reply.
  const opening =
    first === undefined
      ? caseDef.prompt
      : "prompt" in first
        ? first.prompt
        : null;
  const needs: Need[] = [];
  if (caseDef.history !== undefined) {
    needs.push(preamble ? "history" : "historyNative");
  }
  if (caseDef.sessions !== undefined) needs.push("sessionStore");
  const unfitFirst =
    caseDef.history !== undefined &&
    (opening === null || opening.startsWith("/"));
  const blocked: Need[] =
    preamble && (unfitFirst || caseDef.requires.includes("historyNative"))
      ? ["historyNative"]
      : [];
  return { needs, blocked };
}
