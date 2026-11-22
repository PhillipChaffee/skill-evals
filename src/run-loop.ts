import type { Case } from "./cases.js";
import type { DecisionService } from "./decision.js";
import { openCache, scopedCache } from "./cache.js";
import { killRunning } from "./exec.js";
import type { Gate, Limits, StopReason } from "./gate.js";
import { createGate } from "./gate.js";
import type { Located } from "./harnesses/index.js";
import type { HistoryMode } from "./history-types.js";
import type { JudgeApi } from "./judge-api.js";
import type { SandboxCapability } from "./os-sandbox.js";
import { runKey } from "./run-key.js";
import type { Progress } from "./progress.js";
import { etaOf } from "./progress.js";
import type { Judge, RunPlan, RunRecord } from "./run.js";
import { runWithRetries } from "./run-retry.js";
import { pool } from "./schedule.js";
import { slotsOf } from "./slots.js";
import { onInterrupt } from "./scope.js";
import { throttled } from "./throttle.js";
import type { Store } from "./store.js";
import { slotName } from "./store.js";
import type { Subject } from "./subject.js";

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
  /** `--history-mode`; undefined leaves each harness its own mode. */
  historyMode: HistoryMode | undefined;
  lenient: boolean;
  /** Archive each run's files, less the login files. */
  keepWorkspaces: boolean;
  outDir: string;
  judgeApi: JudgeApi | null;
  /** How many runs may be in flight at once. */
  jobs: number;
  /** The retries and the cost and time limits of the command. */
  limits: Limits;
  /** What the machine's sandbox can enforce; null or absent without `--sandbox`. */
  sandbox?: SandboxCapability | null | undefined;
  /** The project root, for the `no_writes_outside_workspace` check; absent: the check watches no project. */
  projectRoot?: string | undefined;
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
  flush: (records: RunRecord[], reason?: "error" | "interrupted") => void;
  /**
   * Called with each run's record as soon as the run ends, in the order the runs end: whether it was reused, and how
   * far the command has got.
   */
  onRun:
    | ((
        record: RunRecord,
        info: { reused: boolean; progress: Progress },
      ) => void)
    | undefined;
  /** When the command started, on the clock `runAll` gets; `--max-duration` counts from here. Default: when `runAll` starts. */
  began?: number | undefined;
  /** The wait after a rate limit, per attempt, in milliseconds. Default: `RATE_LIMIT_BACKOFF_MS`. For tests. */
  rateLimitBackoffMs?: number | undefined;
}

/** What `runAll` returns. */
export interface Ran {
  /** The finished runs in plan order. A run that never started, because a limit was reached, is not here. */
  records: RunRecord[];
  /** Why the command stopped before the end, or ended with graders skipped; null when it ran to the end. */
  stopped: StopReason | null;
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
      historyMode: plan.historyMode,
      lenient: plan.lenient,
      keepWorkspaces: plan.keepWorkspaces,
      outDir: plan.outDir,
      judgeApi: plan.judgeApi ?? undefined,
      sandbox: plan.sandbox ?? undefined,
      projectRoot: plan.projectRoot,
    };
    return { subject, run, key: runKey(run) };
  });

/** What a command knows while it runs. */
interface Tally {
  planned: Planned[];
  /** The record of each planned run, in plan order; undefined until the run is finished or reused. */
  finished: (RunRecord | undefined)[];
  gate: Gate;
  /** The wall time of each run that this command finished, retries included. */
  durations: number[];
}

/**
 * Lists the finished runs.
 * @param tally - What the command knows.
 * @returns The records so far, in plan order.
 */
const sofar = (tally: Tally): RunRecord[] =>
  tally.finished.filter((each) => each !== undefined);

/**
 * Tells how far the command has got.
 * @param tally - What the command knows.
 * @param jobs - How many runs are in flight at once.
 * @param done - How many runs are finished. Default: every one that is.
 * @returns The progress, with the spend of this command's attempts only.
 */
const progressOf = (
  tally: Tally,
  jobs: number,
  done = sofar(tally).length,
): Progress => ({
  done,
  total: tally.planned.length,
  spentUsd: tally.gate.spent(),
  unreported: tally.gate.unreported(),
  etaMs: etaOf(tally.planned.length - done, tally.durations, jobs),
});

/**
 * Makes the job of each run that is not reused: it makes the run with its retries, writes its line, and tells the caller.
 * @param plan - What to run.
 * @param tally - What the command knows; each job adds to it.
 * @param shared - The judge cache, the throttled flush of `results.json`, and the clock.
 * @param shared.cache - The judge cache, read at the start.
 * @param shared.flushSoon - Rewrites `results.json` when the interval has passed.
 * @param shared.clock - The time in milliseconds.
 * @returns The jobs, in plan order.
 */
const jobsOf = (
  plan: Plan,
  tally: Tally,
  shared: {
    cache: ReturnType<typeof openCache>;
    flushSoon: (records: RunRecord[]) => void;
    clock: () => number;
  },
): (() => Promise<void>)[] =>
  tally.planned.flatMap(({ run, key, subject }, index) =>
    tally.finished[index] !== undefined
      ? []
      : [
          async (): Promise<void> => {
            const slot = slotName(key, subject.label);
            const began = shared.clock();
            const { record, attempt } = await runWithRetries(
              {
                ...run,
                cache: scopedCache(shared.cache, slot),
                breached: tally.gate.reached,
              },
              {
                retries: plan.limits.retries,
                gate: tally.gate,
                backoffMs: plan.rateLimitBackoffMs,
              },
            );
            tally.durations.push(shared.clock() - began);
            plan.store.append({ ...record, key, attempt });
            tally.finished[index] = record;
            shared.flushSoon(sofar(tally));
            plan.onRun?.(record, {
              reused: false,
              progress: progressOf(tally, plan.jobs),
            });
          },
        ],
  );

/**
 * Sums up a command whose runs are over.
 * @param plan - What was run.
 * @param tally - What the command knows.
 * @returns The records, and why the command stopped early, if it did: the reason that `check` said "stop" with, or the
 *   reached limit when a run in flight had its graders skipped. Warns once when a budget counted runs with no cost.
 */
function ended(plan: Plan, tally: Tally): Ran {
  const missing = tally.gate.unreported();
  if (plan.limits.maxCost !== undefined && missing > 0) {
    console.error(
      `skill-evals: warning: ${String(missing)} costs were not reported (agent attempts and judge replies); the budget counts only reported costs`,
    );
  }
  const records = sofar(tally);
  const skipped = records.some((record) => record.skippedGraders === true);
  const { gate } = tally;
  return {
    records,
    stopped: gate.stopped() ?? (skipped ? gate.reached() : null),
  };
}

/**
 * Makes every run of a plan, `jobs` at a time. Each run has its own home, workspace and copy of the subject; the
 * records, the judge cache and the results files are written from this process only. `flush` is called once after
 * the reused records are placed, then at most every `FLUSH_INTERVAL_MS`; the caller writes the last one. Before each
 * launch and each retry the gate of `plan.limits` is asked: after it says "stop" no run starts, and those in flight
 * finish, with their judged and decision checks skipped. On SIGINT or SIGTERM the harness processes are killed and
 * `flush` is called with "interrupted" before the process exits.
 * @param plan - What to run.
 * @param clock - The time in milliseconds, for the rate of `flush`, the time limit and the estimate. Default: the system clock.
 * @returns The records in plan order, whatever order the runs ended in, and why the command stopped early, if it did.
 */
export async function runAll(
  plan: Plan,
  clock: () => number = Date.now,
): Promise<Ran> {
  const planned = runsOf(plan);
  const tally: Tally = {
    planned,
    finished: planned.map(({ key, subject }) =>
      plan.reused.get(slotName(key, subject.label)),
    ),
    gate: createGate(plan.limits, clock, plan.began),
    durations: [],
  };
  plan.flush(sofar(tally));
  for (const [index, record] of sofar(tally).entries()) {
    const progress = progressOf(tally, plan.jobs, index + 1);
    plan.onRun?.(record, { reused: true, progress });
  }
  const shared = {
    // Read at the start, and added to after each judged answer.
    cache: openCache(plan.outDir, plan.useCache),
    flushSoon: throttled(
      (records: RunRecord[]) => {
        plan.flush(records);
      },
      FLUSH_INTERVAL_MS,
      clock,
    ),
    clock,
  };
  // The harnesses go first, so that nothing writes while the results are; the lock is released when the process exits.
  const off = onInterrupt(() => {
    killRunning();
    plan.flush(sofar(tally), "interrupted");
    console.error(
      `skill-evals: interrupted after ${String(sofar(tally).length)} of ${String(planned.length)} runs; continue with --resume ${plan.outDir}`,
    );
  });
  try {
    await pool(jobsOf(plan, tally, shared), plan.jobs, tally.gate.check);
  } catch (error) {
    // The file must not go on saying "running" for a command that has ended.
    plan.flush(sofar(tally), "error");
    throw error;
  } finally {
    off();
  }
  return ended(plan, tally);
}
