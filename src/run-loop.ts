import type { Case } from "./cases.js";
import type { DecisionService } from "./decision.js";
import { openCache, scopedCache } from "./cache.js";
import type { Located } from "./harnesses/index.js";
import type { JudgeApi } from "./judge-api.js";
import { runKey } from "./run-key.js";
import type { Judge, RunPlan, RunRecord } from "./run.js";
import { runOnce } from "./run.js";
import { pool } from "./schedule.js";
import { throttled } from "./throttle.js";
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
const slotsOf = <S>(
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

/** What the runs of a plan are made from. */
export interface PlanBase {
  chosen: Located[];
  judgeOf: (located: Located) => Judge;
  decision: DecisionService | null;
  decisionModel: string | undefined;
  decisionUrl: string | undefined;
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
  /** How many runs may be in flight at once. */
  jobs: number;
}

/** The runs to make, in order: for each harness, each case, each rep, each subject. */
export interface Plan extends PlanBase {
  useCache: boolean;
  /** Where each finished run is kept. */
  store: Store;
  /** The records of an earlier command that a run may reuse, by `slotName`. Empty for a fresh run. */
  reused: Map<string, RunRecord>;
  /**
   * Called with every record so far, in plan order, so that `results.json` can be rewritten; with "error" when a run
   * threw and the command ends.
   */
  flush: (records: RunRecord[], reason?: "error") => void;
  /** Called with each run's record as soon as the run ends, in the order the runs end. */
  onRun: ((record: RunRecord, info: { reused: boolean }) => void) | undefined;
}

/** One run of a plan with its key. */
export interface Planned {
  subject: Subject;
  run: RunPlan;
  key: string;
}

/** The least time between two rewrites of `results.json` while runs end. */
export const FLUSH_INTERVAL_MS = 10_000;

/**
 * Makes the run of every slot of a plan, and names it.
 * @param plan - What the runs are made from.
 * @returns Every run in plan order, with its key. No run has a judge cache yet.
 */
export const runsOf = (plan: PlanBase): Planned[] =>
  slotsOf(plan).map(({ located, caseDef, rep, subject }) => {
    const run: RunPlan = {
      ...located,
      subject,
      caseDef,
      rep,
      model: plan.model,
      judge: plan.judgeOf(located),
      decision: plan.decision,
      decisionModel: plan.decisionModel,
      decisionUrl: plan.decisionUrl,
      pass: plan.pass,
      isolated: plan.isolated,
      lenient: plan.lenient,
      outDir: plan.outDir,
      judgeApi: plan.judgeApi ?? undefined,
    };
    return { subject, run, key: runKey(run) };
  });

/**
 * Makes every run of a plan, `jobs` at a time. Each run has its own home, workspace and copy of the subject; the
 * records, the judge cache and the results files are written from this process only. `flush` is called once after
 * the reused records are placed, then at most every `FLUSH_INTERVAL_MS`; the caller writes the last one.
 * @param plan - What to run.
 * @param clock - The time in milliseconds, for the rate of `flush`. Default: the system clock.
 * @returns The records in plan order, whatever order the runs ended in.
 */
export async function runAll(
  plan: Plan,
  clock: () => number = Date.now,
): Promise<RunRecord[]> {
  const { store, reused } = plan;
  // Read at the start, and added to after each judged answer.
  const cache = openCache(plan.outDir, plan.useCache);
  const planned = runsOf(plan);
  const finished = planned.map(({ key, subject }) =>
    reused.get(slotName(key, subject.label)),
  );
  const sofar = (): RunRecord[] =>
    finished.filter((each) => each !== undefined);
  plan.flush(sofar());
  for (const record of sofar()) plan.onRun?.(record, { reused: true });
  const flushSoon = throttled(
    (records: RunRecord[]) => {
      plan.flush(records);
    },
    FLUSH_INTERVAL_MS,
    clock,
  );
  const jobs = planned.flatMap(({ run, key, subject }, index) =>
    finished[index] !== undefined
      ? []
      : [
          async (): Promise<void> => {
            const slot = slotName(key, subject.label);
            const record = await runOnce({
              ...run,
              cache: scopedCache(cache, slot),
            });
            store.append({ ...record, key, attempt: 1 });
            finished[index] = record;
            flushSoon(sofar());
            plan.onRun?.(record, { reused: false });
          },
        ],
  );
  try {
    await pool(jobs, plan.jobs, () => "go");
  } catch (error) {
    // The file must not go on saying "running" for a command that has ended.
    plan.flush(sofar(), "error");
    throw error;
  }
  return sofar();
}
