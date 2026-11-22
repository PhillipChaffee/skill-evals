import { recordedMode } from "./history.js";
import type { HistoryMode } from "./history-types.js";
import { inputHash } from "./input-hash.js";
import type { RunPlan } from "./run-plan.js";

/**
 * Works out the fields of a run record that say what the agent was given.
 * @param plan - The run.
 * @returns `inputHash`, the hash of what the agent sees, `historyMode`, how the case's history reached it (null for a
 *   case with no history), and the subject's `options` when it has any; a record of a subject without options is what it
 *   was before options existed.
 */
export function seenFields(plan: RunPlan): {
  inputHash: string;
  historyMode: HistoryMode | null;
  options?: string;
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
    ...(plan.subject.options === "" ? {} : { options: plan.subject.options }),
  };
}
