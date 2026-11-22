import { recordedMode } from "./history.js";
import type { HistoryMode } from "./history-types.js";
import { inputHash } from "./input-hash.js";
import type { RunPlan } from "./run-plan.js";

/**
 * Works out the two fields of a run record that say what the agent was given.
 * @param plan - The run.
 * @returns `inputHash`, the hash of what the agent sees, and `historyMode`, how the case's history reached it (null for a
 *   case with no history).
 */
export function seenFields(plan: RunPlan): {
  inputHash: string;
  historyMode: HistoryMode | null;
} {
  const { caseDef, harness } = plan;
  const historyMode = recordedMode({
    caseDef,
    harness,
    forced: plan.historyMode,
  });
  return {
    inputHash: inputHash(caseDef, {
      harness: harness.id,
      model: plan.model,
      historyMode,
    }),
    historyMode,
  };
}
