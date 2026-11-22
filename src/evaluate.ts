import type { CaseMeta } from "./case-meta.js";
import type { Comparison } from "./comparison.js";
import type { Case } from "./cases.js";
import type { ExitCode } from "./exit-codes.js";
import { exitCodeOf } from "./exit-codes.js";
import {
  clearStale,
  evaluationOf,
  finalWrite,
  metaOfCommand,
  noteFailure,
  summarize,
  writeLast,
} from "./finish.js";
import type { RunMeta } from "./meta.js";
import { basePlan, prepare, resolveAll } from "./prepare.js";
import type { Prepared } from "./prepare.js";
import { lockDir } from "./lock.js";
import type { Progress } from "./progress.js";
import type { RunRecord } from "./run.js";
import { runAll } from "./run-loop.js";
import { openStore, requireFresh } from "./store.js";
import type { CommonSet, SuiteScore } from "./score.js";
import type { SelectionOptions } from "./select.js";
import { outputDir } from "./scope.js";
import type { Subject, SubjectSummary } from "./subject.js";
import type { Partition } from "./applicability.js";
import type { NotRun } from "./not-run.js";

/** What `evaluate` takes. An option that is not set takes its value from the project's config file. */
export interface EvaluateOptions extends SelectionOptions {
  /** The working directory, which sets the project and what relative paths resolve against. Default: the process's. */
  cwd?: string;
  /** One or two of a directory, a git ref of the project, or "none". */
  subjects: string[];
  /** Comma-separated harness ids, or "all". Default: the first installed harness. */
  harness?: string | undefined;
  /** The directory that holds the cases. Default: `evals/cases` in the project. */
  cases?: string | undefined;
  /** Names of variables the harness gets besides the allowlist. Default: `env` of the config file. */
  env?: string[] | undefined;
  /** Globs, relative to the subject, of what a run never gets. Default: `subjectExclude` of the config file. */
  subjectExclude?: string[] | undefined;
  /** A directory of the subject whose files are its rules. Default: `rules` of the config file. */
  rules?: string | undefined;
  /** A file of the subject that the harness reads as its instructions. Default: `instructionFile` of the config file. */
  instructionFile?: string | undefined;
  /** Runs for each subject and case. A case's own `reps` wins. Default: 3. */
  reps?: number | undefined;
  /** Passed to the harness. A case's own `model` wins. Default: the harness's own default. */
  model?: string | undefined;
  /** The harness that scores judged checks. Default: the harness under test. */
  judgeHarness?: string | undefined;
  /** The model that scores judged checks. A case's own `judgeModel` wins. Default: `model`. */
  judgeModel?: string | undefined;
  /** Ask the judge model over this API and start no harness for it: "anthropic". Default: a harness session. */
  judgeApi?: string | undefined;
  /** The base URL of the judge API. Default: the provider's own. */
  judgeUrl?: string | undefined;
  /** The variable that holds the judge API's key. Default: `ANTHROPIC_API_KEY`. */
  judgeKeyVar?: string | undefined;
  /** The seconds one judge request may take, a positive integer. Default: 120. */
  judgeTimeout?: number | undefined;
  /** Ask the server to fall back when the judge model refuses. Default: true. */
  judgeFallbacks?: boolean | undefined;
  /** Serve judge answers from `judge-cache.jsonl` in the output directory. A fresh run only writes it. Into a directory that already holds `results.jsonl` it needs `resume`, or that file removed. Default: false. */
  useCache?: boolean | undefined;
  /** The model that scores decision checks. No default: a suite with a decision check needs it. */
  decisionModel?: string | undefined;
  /** The base URL of the decision model's API. Default: the provider's own. */
  decisionUrl?: string | undefined;
  /** The seconds one request to the decision model may take, a positive integer. Default: 60. */
  decisionTimeout?: number | undefined;
  /** Drop a key that a case file does not take, and warn, instead of failing. Default: false. */
  lenient?: boolean | undefined;
  /** Start the harness with nothing loaded but the subject, and invalidate a run that reports more. Default: false. */
  isolated?: boolean | undefined;
  /** How a case's `history.json` reaches the agent: "native" or "preamble". A usage error for any other word. Default: each harness's own, which is "preamble". */
  historyMode?: string | undefined;
  /** Archive each run's workspace, seed, remotes and home, less the harness's login files, as `<run>.workspace.tar` in the output directory. A usage error without `tar` on `PATH`. Default: false. */
  keepWorkspaces?: boolean | undefined;
  /** Called with a line of text for each key that `lenient` drops. */
  onWarning?: ((text: string) => void) | undefined;
  /**
   * Called when the runs are over and `results.json` is written, before `summary.json`: the command line writes its
   * reports here. When it throws, `results.json` and `summary.json` say "error" (exit 5), and `evaluate` rejects.
   */
  onFinal?: ((evaluation: Evaluation) => void) | undefined;
  /** The pass bar for the suite score of the subject under test. */
  minScore?: number | undefined;
  /** The least score difference, B minus A, that the suite must show, from -1 to 1. A usage error with one subject. Default: no bar. */
  minDelta?: number | undefined;
  /** A `noise.json` that `calibrate` wrote, which the verdicts use. A usage error when it is not one. Default: the interval alone decides. */
  noise?: string | undefined;
  /** The seed of the bootstrap, a positive integer up to 4294967295. Default: 1. */
  seed?: number | undefined;
  /** Run the first subject against itself: both labels share one export. `calibrate` sets it. Default: false. */
  sameSubject?: boolean | undefined;
  /** The share of the planned runs that may be invalid before the command exits 3, from 0 to 1. Default: 0. */
  maxInvalid?: number | undefined;
  /** The report formats the command line writes: "md" to standard output, the others to `report.<ext>` in the output directory. `evaluate` itself writes none. Default: ["md"]. */
  report?: string[] | undefined;
  /** Where results go. Default: a new temp directory. */
  outDir?: string | undefined;
  /** How many runs may be in flight at once, a positive integer. Default: 1. */
  jobs?: number | undefined;
  /** Tries after the first for a run that failed for a reason that is not the agent's: a harness crash, a rate limit, or a timeout before the harness produced any agent event (its opening init event does not count). The record's `attempts` lists the error, cost and duration of each earlier attempt. A non-negative integer. Default: 0. */
  retries?: number | undefined;
  /** Stop starting runs once the command has spent this many US dollars, summing agent, judge and decision costs of this command's attempts; a positive number. In-flight runs finish with their judged and decision checks skipped. A usage error when a harness, the judge or a decision check reports no cost. Default: no limit. */
  maxCost?: number | undefined;
  /** Stop starting runs after this many minutes, a positive number; fractions are allowed. Default: no limit. */
  maxDuration?: number | undefined;
  /** The milliseconds a rate-limited run waits before its next attempt, times the number of the attempt that failed; for tests. Default: 30,000. */
  rateLimitBackoffMs?: number | undefined;
  /**
   * The output directory of an earlier command, which holds `results.jsonl`. It implies `outDir`. A run whose key matches
   * a valid record there is not repeated; every other run is made and added. It also turns `useCache` on.
   */
  resume?: string | undefined;
  /**
   * Called with each run's record as soon as the run ends. `reused` is true for a record taken from `resume`; `progress`
   * says how many runs are finished (reused ones included), what this command has spent, and the time left.
   */
  onRun?:
    | ((
        record: RunRecord,
        info: { reused: boolean; progress: Progress },
      ) => void)
    | undefined;
}

/** What `evaluate` writes to `results.json`. */
export interface Results {
  /** The version of this file's shape. */
  schemaVersion: 1;
  /** The pass bar for the suite score, `--min-score`; null when none was set. */
  minScore: number | null;
  /** The pass bar for the suite delta, `--min-delta`; null when none was set. */
  minDelta: number | null;
  /** The seed of the bootstrap behind every interval. */
  seed: number;
  /** The noise file the verdicts used, as an absolute path; null when none was given. */
  noiseFile: string | null;
  /** What that file says it measured: its harness, reps and case ids; null with no file. */
  noiseMeta: { harness: string; reps: number; caseIds: string[] } | null;
  /** True when `minDelta` was set and ignored, because one subject has no delta. */
  minDeltaIgnored: boolean;
  /** The share of the planned runs that may be invalid, `--max-invalid`. */
  maxInvalid: number;
  /** How the runs were made: tool and harness versions, models, subject revisions, case hashes. */
  meta: RunMeta;
  subjects: SubjectSummary[];
  harnesses: string[];
  harnessReason: string;
  model: string | null;
  /** The harness and model that scored the judged checks, in words. */
  judge: string;
  /** The model that scored the decision checks; null when none is set. */
  decisionModel: string | null;
  reps: number;
  /** For each case id, what its file holds besides its checks: its labels, what it is about, its overrides, its `x-` keys. */
  caseMeta: Record<string, CaseMeta>;
  suites: SuiteScore[];
  /**
   * The delta of B over A, with its 95% bootstrap interval and verdict, for each case and for the suite of each harness.
   * Null with one subject.
   */
  comparison: Comparison | null;
  /** The pass bars that were not reached. */
  belowBar: string[];
  /** The pairs of harness and case that were not run, because the harness lacks what the case needs. No score, no runs. */
  notApplicable: Partition["notApplicable"];
  /** The checks that a harness dropped from a case that still ran, because they say `ifUnsupported: "skip"`. */
  skippedChecks: Partition["skippedChecks"];
  /**
   * The score over the cases that apply to every harness that has any, for each harness and subject label. Only that
   * number compares harnesses. Null when fewer than two harnesses have an applicable case.
   */
  commonSet: CommonSet | null;
  /** The runs that do not count, each with its reason. */
  invalid: string[];
  /** The paths of a subject directory that changed while the command ran, each as the user would type it. */
  sourceChanged: string[];
  /**
   * Set while the command runs: `results.json` is then a snapshot, rewritten at most every 10 seconds, and `reason` is
   * "running". The last write of a command that stopped early has its reason: "error" when a run threw, "budget" at
   * `maxCost`, "duration" at `maxDuration` (both exit 4), "interrupted" on SIGINT or SIGTERM (exit 130). A command that
   * ran to the end has null. A run in flight at "budget" or "duration" may carry `skippedGraders`; `--resume` repeats it.
   */
  partial: {
    reason: "running" | "error" | "budget" | "duration" | "interrupted";
  } | null;
  /**
   * The runs of the plan that did not run, in plan order: those that were never started because the command stopped,
   * and those that were started but had their judged and decision checks skipped (they are in `records`, invalid, with
   * `skippedGraders`). Empty for a command that ran to the end. While the command runs, the runs not finished yet.
   */
  notRun: NotRun[];
  records: RunRecord[];
}

/** What `evaluate` returns. The evaluation succeeded when `exit` is 0, that is when `belowBar`, `sourceChanged` and `invalid` (within `maxInvalid`) are clear, every case has a valid run, and `partial` is null: a command that stopped early (`partial` set, `notRun` listing what did not run) scored only the runs that finished. */
export interface Evaluation extends Results {
  /** The exit code the command line gives: 0, 1, 3 or 4. A failure rejects, and a signal ends the process, so 5 and 130 are never returned. `summary.json` holds the same number. */
  exit: ExitCode;
  /** Every loaded case, applicable or not. */
  cases: Case[];
  /** For each harness id, the cases it ran, with the checks that it dropped left out. */
  applied: Record<string, Case[]>;
  outDir: string;
}

/** What the caller hooks into, and when the command started. */
interface Hooks {
  onRun: EvaluateOptions["onRun"];
  onFinal: EvaluateOptions["onFinal"];
  began: number;
}

/**
 * Makes the runs, writing each record as its run ends, and sums them up.
 * @param prepared - What `prepare` returned.
 * @param subjects - The subjects, resolved.
 * @param hooks - The output directory, which is locked, the hooks of the caller, and when the command started.
 * @param hooks.outDir - The output directory.
 * @param hooks.onRun - Called with each run's record as it ends.
 * @param hooks.onFinal - Called when `results.json` is written, before `summary.json`.
 * @param hooks.began - When the command started, which `maxDuration` counts from.
 * @returns The results.
 */
async function runLocked(
  prepared: Prepared,
  subjects: Subject[],
  hooks: Hooks & { outDir: string },
): Promise<Results> {
  const { outDir } = hooks;
  const { context } = prepared;
  const { options, resumed } = context;
  // Another command may have filled the directory while the subjects were exported, and before it was locked.
  if (resumed === undefined) requireFresh(outDir);
  const store = openStore(outDir, resumed !== undefined);
  // Every check that can refuse the command comes before the files of the earlier command are removed.
  const reused =
    resumed === undefined ? new Map<string, RunRecord>() : store.load();
  const finished = {
    ...context,
    subjects,
    meta: await metaOfCommand(context, subjects),
  };
  clearStale(outDir);
  const { records, stopped } = await runAll({
    ...basePlan(context, subjects, outDir),
    useCache: resumed !== undefined || (options.useCache ?? false),
    store,
    reused,
    flush: (
      records,
      reason: Exclude<Results["partial"], null>["reason"] = "running",
    ) => {
      const results = summarize({
        ...finished,
        records,
        sourceChanged: [],
        partial: { reason },
      });
      if (reason === "running") store.flush(results);
      else writeLast(store, results, finished.maxInvalid);
    },
    onRun: hooks.onRun,
    began: hooks.began,
    rateLimitBackoffMs: options.rateLimitBackoffMs,
  });
  return finalWrite(store, finished, {
    records,
    stopped,
    after: (results, exit) => {
      hooks.onFinal?.(evaluationOf(results, context, { outDir, exit }));
    },
  });
}

/**
 * Locks the output directory and makes the runs in it. A failure that is not a usage error leaves a summary that says
 * exit 5, when none was written.
 * @param prepared - What `prepare` returned.
 * @param subjects - The subjects, resolved.
 * @param hooks - See `runLocked`.
 * @param hooks.onRun - Called with each run's record as it ends.
 * @param hooks.onFinal - Called when `results.json` is written, before `summary.json`.
 * @param hooks.began - When the command started, which `maxDuration` counts from.
 * @returns The results and the output directory.
 */
async function runSuite(
  prepared: Prepared,
  subjects: Subject[],
  hooks: Hooks,
): Promise<{ results: Results; outDir: string }> {
  const { context } = prepared;
  const outDir =
    context.resumed ?? outputDir(context.options.outDir, context.cwd);
  if (context.resumed !== undefined && context.model === undefined) {
    console.error(
      "skill-evals: warning: --resume without --model: reused runs may come from a different default model",
    );
  }
  const release = lockDir(outDir);
  try {
    return {
      results: await runLocked(prepared, subjects, { ...hooks, outDir }),
      outDir,
    };
  } catch (error) {
    noteFailure(outDir, error);
    throw error;
  } finally {
    release();
  }
}

/**
 * Runs every case against each subject, scores the runs, and writes `results.json` and each run's files to the
 * output directory. One subject is scored on its own. With two, the first is the baseline and the second is the one
 * under test, which the pass bars apply to. It prints nothing and never calls process.exit. While it runs, SIGINT
 * and SIGTERM end the process with exit code 130 after the cleanup.
 * @param given - What to evaluate and how. An option that is not set takes its value from the project's config file.
 * @returns The scores, every run record, and where the files are.
 * @throws {UsageError} For a wrong option, case file, or config file, before any harness starts.
 */
export async function evaluate(given: EvaluateOptions): Promise<Evaluation> {
  const began = Date.now();
  const { onRun, onFinal, ...rest } = given;
  const prepared = prepare(rest);
  const subjects: Subject[] = [];
  try {
    resolveAll(prepared, subjects);
    const { results, outDir } = await runSuite(prepared, subjects, {
      onRun,
      onFinal,
      began,
    });
    const { maxInvalid } = prepared.context;
    return evaluationOf(results, prepared.context, {
      outDir,
      exit: exitCodeOf(results, maxInvalid),
    });
  } finally {
    for (const subject of subjects) subject.dispose();
  }
}
