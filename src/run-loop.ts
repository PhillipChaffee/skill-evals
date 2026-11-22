import type { Case } from "./cases.js";
import type { DecisionService } from "./decision.js";
import { openCache } from "./cache.js";
import type { Located } from "./harnesses/index.js";
import type { JudgeApi } from "./judge-api.js";
import { runKey } from "./run-key.js";
import type { Judge, RunRecord } from "./run.js";
import { runOnce } from "./run.js";
import { pool } from "./schedule.js";
import type { Store } from "./store.js";
import { slotName } from "./store.js";
import type { Subject } from "./subject.js";

/** One run of a plan, before it is made. */
export interface Slot<S> {
  located: Located;
  caseDef: Case;
  rep: number;
  subject: S;
}

/**
 * Lists the runs of a plan in plan order: for each harness, each case, each rep, each subject.
 * @param plan - The harnesses, the cases each runs, the reps, and the subjects or whatever stands for them.
 * @returns Every run.
 */
export const slotsOf = <S>(
  plan: Pick<Plan, "chosen" | "applied" | "reps"> & { subjects: S[] },
): Slot<S>[] => {
  const { chosen, applied, reps, subjects } = plan;
  return chosen.flatMap((located) =>
    (applied[located.harness.id] ?? []).flatMap((caseDef) =>
      Array.from({ length: caseDef.reps ?? reps }, (_, index) =>
        subjects.map((subject) => ({
          located,
          caseDef,
          rep: index + 1,
          subject,
        })),
      ).flat(),
    ),
  );
};

/** The runs to make, in order: for each harness, each case, each rep, each subject. */
export interface Plan {
  chosen: Located[];
  judgeOf: (located: Located) => Judge;
  decision: DecisionService | null;
  decisionModel: string | undefined;
  pass: string[] | undefined;
  /** For each harness id, the cases it runs. */
  applied: Record<string, Case[]>;
  reps: number;
  subjects: Subject[];
  model: string | undefined;
  isolated: boolean;
  lenient: boolean;
  outDir: string;
  judgeApi: JudgeApi | null;
  useCache: boolean;
  /** How many runs may be in flight at once. */
  jobs: number;
  /** Where each finished run is kept. */
  store: Store;
  /** The records of an earlier command that a run may reuse, by `slotName`. Empty for a fresh run. */
  reused: Map<string, RunRecord>;
  /** Called after each run with every record so far, in plan order, so that `results.json` can be rewritten. */
  flush: (records: RunRecord[]) => void;
  /** Called with each run's record as soon as the run ends, in the order the runs end. */
  onRun: ((record: RunRecord, info: { reused: boolean }) => void) | undefined;
}

/**
 * Makes every run of a plan, `jobs` at a time. Each run has its own home, workspace and copy of the subject; the
 * records, the judge cache and the results files are written from this process only.
 * @param plan - What to run.
 * @returns The records in plan order, whatever order the runs ended in.
 */
export async function runAll(plan: Plan): Promise<RunRecord[]> {
  const { store, reused } = plan;
  // Read at the start, and added to after each judged answer.
  const cache = openCache(plan.outDir, plan.useCache);
  const slots = slotsOf(plan);
  const finished: (RunRecord | undefined)[] = slots.map(() => undefined);
  const jobs = slots.map(({ located, caseDef, rep, subject }, index) => {
    const run = {
      ...located,
      subject,
      caseDef,
      rep,
      model: plan.model,
      judge: plan.judgeOf(located),
      decision: plan.decision,
      decisionModel: plan.decisionModel,
      pass: plan.pass,
      isolated: plan.isolated,
      lenient: plan.lenient,
      outDir: plan.outDir,
      judgeApi: plan.judgeApi ?? undefined,
      cache,
    };
    return async (): Promise<RunRecord> => {
      const key = runKey(run);
      const prior = reused.get(slotName(key, subject.label));
      const record = prior ?? (await runOnce(run));
      if (!prior) store.append({ ...record, key, attempt: 1 });
      finished[index] = record;
      plan.flush(finished.filter((each) => each !== undefined));
      plan.onRun?.(record, { reused: prior !== undefined });
      return record;
    };
  });
  const records = await pool(jobs, plan.jobs, () => "go");
  return records.filter((each) => each !== undefined);
}
