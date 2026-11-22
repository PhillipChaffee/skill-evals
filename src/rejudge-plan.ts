import { partitionApplicable } from "./applicability.js";
import type { Case } from "./cases.js";
import type { Results } from "./evaluate.js";
import type { Harness } from "./harnesses/shared.js";
import { inputHash } from "./input-hash.js";
import type { RunRecord } from "./run.js";
import { caseHash } from "./run-key.js";
import type { Selection } from "./select.js";
import { selectCases } from "./select.js";

/** Why a run is not re-scored, as the listing words it. */
const CHANGED_BEYOND_CHECKS =
  "not re-scored: the case changed beyond its checks";

/** What `rejudge` does with one stored run. */
type Verdict =
  { kind: "rescore"; caseDef: Case } | { kind: "keep"; note: string | null };

/** What `rejudge` does with every run of the earlier command. */
export interface Plan {
  /** One verdict for each record of the earlier results, in their order. */
  verdicts: Verdict[];
  /** The cases that are re-scored, by id, as the cases directory has them. */
  live: Map<string, Case>;
  /** For each harness id, the live cases as that harness runs them. */
  ran: Record<string, Map<string, Case>>;
  /** The hash of each re-scored case, by harness id and case id. */
  hashes: Record<string, Record<string, string>>;
  /** How many re-scored runs were stored before `inputHash` existed. */
  unhashed: number;
}

/** What the plan reads besides the earlier results. */
interface Given {
  /** Every case of the cases directory, held-out variants included. */
  all: Case[];
  /** The `--case` options and the like; the held-out variants are always read. */
  selection: Selection;
  /** The harnesses that the earlier command ran. */
  harnesses: { harness: Harness }[];
}

/**
 * Decides what to do with each run of an earlier command.
 * @param source - The earlier results.
 * @param given - The cases now, which of them the user selected, and the harnesses.
 * @returns A verdict for each run. A run is kept as it was when its case is not in the cases directory, was not
 *   selected, does not apply to the harness now, or changed beyond its checks: its `inputHash` differs from the case's.
 *   A run with no `inputHash` is re-scored.
 */
export function planRejudge(source: Results, given: Given): Plan {
  const byId = new Map(given.all.map((one) => [one.id, one]));
  const selected = new Set(
    selectCases(given.all, { ...given.selection, heldout: true }).map(
      (one) => one.id,
    ),
  );
  const applied = partitionApplicable(given.harnesses, given.all).ran;
  const current = (record: RunRecord): Case | undefined =>
    applied[record.harness]?.find((one) => one.id === record.caseId);
  const changed = new Set<string>();
  let unhashed = 0;
  const verdicts = source.records.map((record): Verdict => {
    if (!byId.has(record.caseId)) {
      return {
        kind: "keep",
        note: "kept unchanged: the case is not in the cases directory",
      };
    }
    if (!selected.has(record.caseId)) return { kind: "keep", note: null };
    const caseDef = current(record);
    if (caseDef === undefined) {
      return {
        kind: "keep",
        note: `kept unchanged: the case does not apply to ${record.harness} now`,
      };
    }
    const now = inputHash(caseDef, {
      harness: record.harness,
      model: source.model ?? undefined,
    });
    if (record.inputHash !== undefined && record.inputHash !== now) {
      changed.add(record.caseId);
      return { kind: "keep", note: CHANGED_BEYOND_CHECKS };
    }
    if (record.inputHash === undefined) unhashed += 1;
    return { kind: "rescore", caseDef };
  });
  const live = new Map<string, Case>();
  const ran: Plan["ran"] = {};
  const hashes: Plan["hashes"] = {};
  for (const [index, verdict] of verdicts.entries()) {
    const record = source.records[index];
    if (verdict.kind !== "rescore" || record === undefined) continue;
    if (changed.has(record.caseId)) continue;
    const { caseDef } = verdict;
    live.set(caseDef.id, byId.get(caseDef.id) ?? caseDef);
    (ran[record.harness] ??= new Map()).set(caseDef.id, caseDef);
    (hashes[record.harness] ??= {})[caseDef.id] = caseHash(caseDef);
  }
  return { verdicts, live, ran, hashes, unhashed };
}
