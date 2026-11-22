import { metaOf } from "./case-meta.js";
import type { Case } from "./cases.js";
import type { Results } from "./evaluate.js";
import { exitCodeOf } from "./exit-codes.js";
import type { Located } from "./harnesses/index.js";
import type { JudgeApi } from "./judge-api.js";
import type { RunMeta } from "./meta.js";
import { harnessVersions, runMetaOf } from "./meta.js";
import { notRunOf, plannedRuns } from "./not-run.js";
import type { Context } from "./prepare.js";
import type { RunRecord } from "./run.js";
import { invalidReason, modesOf } from "./run.js";
import type { StopReason } from "./gate.js";
import { onInterrupt } from "./scope.js";
import { commonSet, failedBars, scoreSuites } from "./score.js";
import type { Store } from "./store.js";
import type { Subject } from "./subject.js";
import { changedAtSource } from "./subject.js";
import { summaryOf } from "./summary.js";
import type { Partition } from "./applicability.js";

/** What a finished evaluation is summed up from. */
export interface Finished {
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
  meta: RunMeta;
  maxInvalid: number;
  records: RunRecord[];
  sourceChanged: string[];
  partial: Results["partial"];
}

/**
 * Lists the runs that do not count.
 * @param records - The finished runs.
 * @returns One line for each invalid run: the run, and why.
 */
const invalidList = (records: RunRecord[]): string[] =>
  records.flatMap((record) => {
    const reason = invalidReason(record);
    const run = `${record.harness} ${record.caseId} ${record.subject}${String(record.rep)}`;
    return reason === null ? [] : [`${run}: ${reason}`];
  });

/**
 * Scores the runs and sums up what ran.
 * @param finished - The runs and what they were made with.
 * @returns What goes into `results.json`. The pass bars apply to the last subject, which is the one under test.
 */
export function summarize(finished: Finished): Results {
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
    reps: finished.reps,
  });
  return {
    schemaVersion: 1,
    meta: finished.meta,
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
    invalid: invalidList(records),
    sourceChanged: finished.sourceChanged,
    partial: finished.partial,
    notRun: notRunOf(
      plannedRuns({
        harnesses,
        applied: parts.ran,
        reps: finished.reps,
        labels,
      }),
      records,
    ),
    records,
  };
}

/**
 * Gathers what a command records about how its runs are made. It asks each harness that may start for its version.
 * @param context - What `prepare` settled.
 * @param subjects - The resolved subjects.
 * @returns The `meta` of `results.json`.
 */
export const metaOfCommand = (context: Context, subjects: Subject[]): RunMeta =>
  runMetaOf({
    versions: harnessVersions([
      ...context.selection.chosen,
      ...(context.judgeApi ? [] : [context.judgeHarness]),
    ]),
    models: {
      agent: context.model,
      judge: context.judgeModel,
      decision: context.decisionModel,
    },
    subjects,
    cases: context.cases,
    isolated: modesOf(context.options).isolated,
  });

/**
 * Writes the last `results.json` and `summary.json` of a command.
 * @param store - Where they go.
 * @param results - What to write.
 * @param maxInvalid - `--max-invalid`, which the summary's exit code depends on.
 * @returns The results that were written.
 */
export function writeLast(
  store: Store,
  results: Results,
  maxInvalid: number,
): Results {
  store.finish(results, summaryOf(results, exitCodeOf(results, maxInvalid)));
  return results;
}

/**
 * Writes the last `results.json` of a command that ran its runs. A signal while the subjects are checked still leaves
 * the file saying "interrupted", not "running".
 * @param store - Where the results go.
 * @param finished - What the results are summed up from, besides the records.
 * @param ran - What `runAll` returned.
 * @param ran.records - The finished runs.
 * @param ran.stopped - Why the command stopped early, or null.
 * @returns The results that were written.
 */
export function finalWrite(
  store: Store,
  finished: Omit<Finished, "records" | "sourceChanged" | "partial">,
  ran: { records: RunRecord[]; stopped: StopReason | null },
): Results {
  const { records, stopped } = ran;
  const off = onInterrupt(() => {
    writeLast(
      store,
      summarize({
        ...finished,
        records,
        sourceChanged: [],
        partial: { reason: "interrupted" },
      }),
      finished.maxInvalid,
    );
  });
  try {
    return writeLast(
      store,
      summarize({
        ...finished,
        records,
        sourceChanged: changedAtSource(finished.subjects),
        partial: stopped === null ? null : { reason: stopped },
      }),
      finished.maxInvalid,
    );
  } finally {
    off();
  }
}
