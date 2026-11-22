import type { CaseMeta } from "./case-meta.js";
import { metaOf } from "./case-meta.js";
import type { Case } from "./cases.js";
import { basePlan, prepare, resolveAll } from "./prepare.js";
import type { Prepared } from "./prepare.js";
import { lockDir } from "./lock.js";
import type { JudgeApi } from "./judge-api.js";
import type { Located } from "./harnesses/index.js";
import type { RunRecord } from "./run.js";
import { invalidReason } from "./run.js";
import { runAll } from "./run-loop.js";
import { openStore, requireFresh } from "./store.js";
import type { CommonSet, SuiteScore } from "./score.js";
import { commonSet, failedBars, scoreSuites } from "./score.js";
import type { SelectionOptions } from "./select.js";
import { outputDir } from "./scope.js";
import type { Subject, SubjectSummary } from "./subject.js";
import { changedAtSource } from "./subject.js";
import type { Partition } from "./applicability.js";

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
  /** Serve judge answers from `judge-cache.jsonl` in the output directory. A fresh run only writes it. Default: false. */
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
  /** Called with a line of text for each key that `lenient` drops. */
  onWarning?: ((text: string) => void) | undefined;
  /** The pass bar for the suite score of the subject under test. */
  minScore?: number | undefined;
  /** Where results go. Default: a new temp directory. */
  outDir?: string | undefined;
  /** How many runs may be in flight at once, a positive integer. Default: 1. */
  jobs?: number | undefined;
  /**
   * The output directory of an earlier command, which holds `results.jsonl`. It implies `outDir`. A run whose key matches
   * a valid record there is not repeated; every other run is made and added. It also turns `useCache` on.
   */
  resume?: string | undefined;
  /** Called with each run's record as soon as the run ends; `reused` is true for a record taken from `resume`. */
  onRun?: ((record: RunRecord, info: { reused: boolean }) => void) | undefined;
}

/** What `evaluate` writes to `results.json`. */
export interface Results {
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
   * "running". The last write has null.
   */
  partial: { reason: "running" } | null;
  records: RunRecord[];
}

/** What `evaluate` returns. The evaluation succeeded when `belowBar`, `invalid` and `sourceChanged` are all empty. */
export interface Evaluation extends Results {
  /** Every loaded case, applicable or not. */
  cases: Case[];
  /** For each harness id, the cases it ran, with the checks that it dropped left out. */
  applied: Record<string, Case[]>;
  outDir: string;
}

/** What a finished evaluation is summed up from. */
interface Finished {
  subjects: Subject[];
  selection: { chosen: Located[]; reason: string };
  judgeHarness: Located | undefined;
  judgeModel: string | undefined;
  judgeApi: JudgeApi | null;
  decisionModel: string | undefined;
  model: string | undefined;
  minScore: number | undefined;
  reps: number;
  cases: Case[];
  parts: Partition;
  records: RunRecord[];
  sourceChanged: string[];
  partial: Results["partial"];
}

/**
 * Scores the runs and sums up what ran.
 * @param finished - The runs and what they were made with.
 * @returns What goes into `results.json`. The pass bars apply to the last subject, which is the one under test.
 */
function summarize(finished: Finished): Results {
  const { subjects, selection, judgeHarness, judgeModel, model } = finished;
  const judgeWho = finished.judgeApi
    ? `the ${finished.judgeApi.kind} API`
    : (judgeHarness?.harness.id ?? "the harness under test");
  const { cases, records } = finished;
  const labels = subjects.map(({ label }) => label);
  const harnesses = selection.chosen.map(({ harness }) => harness.id);
  const { parts } = finished;
  const applicable = Object.fromEntries(
    Object.entries(parts.ran).map(([id, ran]) => [id, ran.map((c) => c.id)]),
  );
  const suites = scoreSuites({
    harnesses,
    cases,
    records,
    labels,
    applicable,
  });
  return {
    subjects: subjects.map(({ label, spec, kind, dir, skills, commit }) => ({
      label,
      spec,
      kind,
      dir,
      skills,
      commit,
    })),
    harnesses,
    harnessReason: selection.reason,
    model: model ?? null,
    judge: `${judgeWho}, model ${judgeModel ?? "the harness default"}`,
    decisionModel: finished.decisionModel ?? null,
    reps: finished.reps,
    caseMeta: Object.fromEntries(cases.map((one) => [one.id, metaOf(one)])),
    suites,
    belowBar: failedBars(suites, labels.at(-1) ?? "", finished.minScore),
    notApplicable: parts.notApplicable,
    skippedChecks: parts.skippedChecks,
    commonSet: commonSet({ harnesses, cases, records, labels, applicable }),
    invalid: records.flatMap((record) => {
      const reason = invalidReason(record);
      const run = `${record.harness} ${record.caseId} ${record.subject}${String(record.rep)}`;
      return reason === null ? [] : [`${run}: ${reason}`];
    }),
    sourceChanged: finished.sourceChanged,
    partial: finished.partial,
    records,
  };
}

/**
 * Makes the runs, writing each record as its run ends, and sums them up.
 * @param prepared - What `prepare` returned.
 * @param subjects - The subjects, resolved.
 * @param onRun - The hook of the caller.
 * @returns The results and the output directory.
 */
async function runSuite(
  prepared: Prepared,
  subjects: Subject[],
  onRun: EvaluateOptions["onRun"],
): Promise<{ results: Results; outDir: string }> {
  const { context } = prepared;
  const { options, resumed } = context;
  const outDir = resumed ?? outputDir(options.outDir, context.cwd);
  if (resumed === undefined) requireFresh(outDir);
  else if (context.model === undefined) {
    console.error(
      "skill-evals: warning: --resume without --model: reused runs may come from a different default model",
    );
  }
  const release = lockDir(outDir);
  try {
    const store = openStore(outDir, resumed !== undefined);
    const finished = { ...context, subjects };
    const records = await runAll({
      ...basePlan(context, subjects, outDir),
      useCache: resumed !== undefined || (options.useCache ?? false),
      store,
      reused:
        resumed === undefined ? new Map<string, RunRecord>() : store.load(),
      flush: (records) => {
        store.flush(
          summarize({
            ...finished,
            records,
            sourceChanged: [],
            partial: { reason: "running" },
          }),
        );
      },
      onRun,
    });
    const results = summarize({
      ...finished,
      records,
      sourceChanged: changedAtSource(subjects),
      partial: null,
    });
    store.flush(results);
    return { results, outDir };
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
  const { onRun, ...rest } = given;
  const prepared = prepare(rest);
  const subjects: Subject[] = [];
  try {
    resolveAll(prepared, subjects);
    const { results, outDir } = await runSuite(prepared, subjects, onRun);
    const { cases, parts } = prepared.context;
    return { ...results, cases, applied: parts.ran, outDir };
  } finally {
    for (const subject of subjects) subject.dispose();
  }
}
