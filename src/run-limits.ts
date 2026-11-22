import type { Case } from "./cases.js";
import type { Harness } from "./harnesses/shared.js";
import type { SessionResult } from "./session.js";
import type { StoppedBy } from "./session-end.js";

/** The fields of a run record that say how the run ended and what its limits did. */
export interface LimitFields {
  /**
   * Who ended the run: "agent" when the runner did not stop the process (a crash or a start that failed included, with
   * `error` saying why), "maxTurns" when the run was stopped at the case's `maxTurns` (by the runner, or by Claude
   * Code's own `--max-turns`), "timeout" when the time limit stopped it. A run stopped at `maxTurns` is valid and
   * scored; a timeout is invalid unless the case sets `onTimeout: "score"`. For a stopped run, `tokens` and `costUsd`
   * are null when the harness writes its totals only at the end. Absent from earlier records.
   */
  stoppedBy?: StoppedBy;
  /**
   * Whether the harness counted turns against the case's `maxTurns`: null when the case sets none, true when it set
   * one and the harness counts turns (it has `turnGrouping`), false when it set one and the harness cannot count
   * them. The report lists the false ones under "Limits not enforced". Absent from earlier records.
   */
  maxTurnsEnforced?: boolean | null;
  /**
   * The main-thread turns the runner counted in the stream, subagent turns left out, up to the stop for a run stopped at `maxTurns` (output that arrives while the process group is killed is not counted), and the lines read until the process was gone for a timeout (the drain included); null for a harness without
   * `turnGrouping`. A run stopped at `maxTurns` shows at least `maxTurns + 1`, because the runner stops as the next turn begins, and turns that arrive in the same chunk are counted too.
   * Absent from earlier records.
   */
  turns?: number | null;
  /** Milliseconds from the start of the prompt to the first byte of the harness's output; null when it wrote none. Absent from earlier records. */
  firstOutputMs?: number | null;
}

/**
 * Makes the limit fields of a record.
 * @param harness - The adapter that ran.
 * @param caseDef - The case, which may set `maxTurns`.
 * @param ran - What the session saw; absent for a run that never got that far.
 * @returns The four fields, all set.
 */
export function limitFields(
  harness: Harness,
  caseDef: Pick<Case, "maxTurns">,
  ran?: Pick<SessionResult, "stoppedBy" | "turns" | "firstOutputMs">,
): Required<LimitFields> {
  return {
    stoppedBy: ran?.stoppedBy ?? "agent",
    maxTurnsEnforced:
      caseDef.maxTurns === undefined ? null : harness.countTurns !== undefined,
    turns: ran?.turns ?? null,
    firstOutputMs: ran?.firstOutputMs ?? null,
  };
}
