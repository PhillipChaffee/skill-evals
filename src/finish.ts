import { metaOf } from "./case-meta.js";
import type { Comparison } from "./comparison.js";
import { compare, failedDeltaBars } from "./comparison.js";
import type { DeltaSetup } from "./evaluate-setup.js";
import type { Case } from "./cases.js";
import fs from "node:fs";
import path from "node:path";
import type { Evaluation, Results } from "./evaluate.js";
import type { ExitCode } from "./exit-codes.js";
import { EXIT, exitCodeOf } from "./exit-codes.js";
import { FORMATS } from "./report/formats.js";
import type { Located } from "./harnesses/index.js";
import type { JudgeApi } from "./judge-api.js";
import type { RunMeta } from "./meta.js";
import { harnessVersions, runMetaOf } from "./meta.js";
import { NOISE_FILE } from "./noise.js";
import { notRunOf, plannedRuns } from "./not-run.js";
import type { Context } from "./prepare.js";
import { isJudged } from "./checks/index.js";
import type { RunRecord } from "./run.js";
import { invalidReason, modesOf } from "./run.js";
import type { StopReason } from "./gate.js";
import { UsageError, onInterrupt } from "./scope.js";
import { commonSet, failedBars, scoreSuites } from "./score.js";
import type { Store } from "./store.js";
import type { Subject, SubjectSummary } from "./subject.js";
import { changedAtSource } from "./subject.js";
import type { Summary } from "./summary.js";
import { summaryOf } from "./summary.js";
import type { Partition } from "./applicability.js";

/** What a finished evaluation is summed up from. */
export interface Finished {
  subjects: SubjectSummary[];
  selection: { chosen: { harness: { id: string } }[]; reason: string };
  judgeHarness: Located | undefined;
  judgeModel: string | undefined;
  judgeApi: JudgeApi | null;
  decisionModel: string | undefined;
  model: string | undefined;
  minScore: number | undefined;
  /** The delta bar, the seed of the bootstrap, and the noise file. */
  delta: DeltaSetup;
  reps: number;
  cases: Case[];
  parts: Partition;
  meta: RunMeta;
  maxInvalid: number;
  records: RunRecord[];
  sourceChanged: string[];
  partial: Results["partial"];
  /** Who scored the judged checks, in words; absent: `judgeText` says it from the judge fields. */
  judgeLabel?: string;
}

/**
 * Takes the part of a subject that goes into `results.json`.
 * @param subject - A resolved subject.
 * @returns Its label, spec, kind, directory, skills and commit.
 */
const summaryOfSubject = (subject: SubjectSummary): SubjectSummary => ({
  label: subject.label,
  spec: subject.spec,
  kind: subject.kind,
  dir: subject.dir,
  skills: subject.skills,
  commit: subject.commit,
});

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
 * Compares subject A with subject B when there are two.
 * @param finished - The runs and what they were made with.
 * @param harnesses - The ids of the harnesses, in report order.
 * @returns The comparison; null for one subject.
 */
function comparisonOf(
  finished: Finished,
  harnesses: string[],
): Comparison | null {
  const [first, second] = finished.subjects;
  return first && second
    ? compare({
        harnesses,
        applied: finished.parts.ran,
        records: finished.records,
        kinds: { a: first.kind, b: second.kind },
        seed: finished.delta.seed,
        noise: finished.delta.noise?.noise ?? null,
      })
    : null;
}

/**
 * Lists the ids of the cases that apply to each harness.
 * @param parts - What `partitionApplicable` returned.
 * @returns For each harness id, the ids of the cases it ran.
 */
const applicableIds = (parts: Partition): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(parts.ran).map(([id, ran]) => [id, ran.map((c) => c.id)]),
  );

/**
 * Says in words who scores the judged checks.
 * @param finished - The runs and what they were made with.
 * @returns The harness or API, and its model.
 */
export function judgeText(
  finished: Pick<Finished, "judgeApi" | "judgeHarness" | "judgeModel">,
): string {
  const who = finished.judgeApi
    ? `the ${finished.judgeApi.kind} API`
    : (finished.judgeHarness?.harness.id ?? "the harness under test");
  return `${who}, model ${finished.judgeModel ?? "the harness default"}`;
}

/**
 * Takes the part of `results.json` that a comparison adds.
 * @param delta - The delta bar, the seed and the noise file.
 * @param comparison - What `comparisonOf` returned.
 * @returns The bar, the seed, the noise file's path and the comparison.
 */
const deltaFields = (delta: DeltaSetup, comparison: Comparison | null) => ({
  minDelta: delta.minDelta ?? null,
  seed: delta.seed,
  noiseFile: delta.noise?.file ?? null,
  noiseMeta: delta.noise
    ? {
        harness: delta.noise.noise.harness,
        reps: delta.noise.noise.reps,
        caseIds: delta.noise.noise.caseIds,
      }
    : null,
  minDeltaIgnored: delta.ignored,
  comparison,
});

/**
 * Scores the runs and sums up what ran.
 * @param finished - The runs and what they were made with.
 * @returns What goes into `results.json`. The pass bars apply to the last subject, which is the one under test.
 */
export function summarize(finished: Finished): Results {
  const { subjects, selection, model } = finished;
  const { cases, records } = finished;
  const labels = subjects.map(({ label }) => label);
  const harnesses = selection.chosen.map(({ harness }) => harness.id);
  const { parts } = finished;
  const applicable = applicableIds(parts);
  const suites = scoreSuites({
    harnesses,
    cases,
    records,
    labels,
    applicable,
    reps: finished.reps,
  });
  const comparison = comparisonOf(finished, harnesses);
  return {
    schemaVersion: 1,
    meta: finished.meta,
    minScore: finished.minScore ?? null,
    ...deltaFields(finished.delta, comparison),
    maxInvalid: finished.maxInvalid,
    subjects: subjects.map(summaryOfSubject),
    harnesses,
    harnessReason: selection.reason,
    model: model ?? null,
    judge: finished.judgeLabel ?? judgeText(finished),
    decisionModel: finished.decisionModel ?? null,
    reps: finished.reps,
    caseMeta: Object.fromEntries(cases.map((one) => [one.id, metaOf(one)])),
    suites,
    belowBar: [
      ...failedBars(suites, labels.at(-1) ?? "", finished.minScore),
      ...failedDeltaBars(comparison, finished.delta.minDelta ?? null),
    ],
    notApplicable: parts.notApplicable,
    skippedChecks: parts.skippedChecks,
    commonSet: commonSet({
      harnesses,
      cases,
      records,
      labels,
      applicable,
      reps: finished.reps,
    }),
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
 * Gathers what a command records about how its runs are made. It asks each harness that will start for its version, all
 * at once, and waits for the answers.
 * @param context - What `prepare` settled.
 * @param subjects - The resolved subjects.
 * @returns The `meta` of `results.json`.
 */
export async function metaOfCommand(
  context: Context,
  subjects: Subject[],
): Promise<RunMeta> {
  const runs = (located: Located): boolean =>
    (context.parts.ran[located.harness.id]?.length ?? 0) > 0;
  const judged = context.cases.some((one) => one.checks.some(isJudged));
  return runMetaOf({
    versions: await harnessVersions([
      ...context.selection.chosen.filter(runs),
      ...(judged && !context.judgeApi ? [context.judgeHarness] : []),
    ]),
    models: {
      agent: context.model,
      judge: context.judgeModel,
      decision: context.decisionModel,
    },
    subjects,
    applied: context.parts.ran,
    isolated: modesOf(context.options).isolated,
  });
}

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
 * Writes the last `results.json` of a command that ran its runs, then lets the caller write its reports, then writes
 * `summary.json`, so that a report that cannot be written is an error that the summary says. A signal before the end
 * still leaves the files saying "interrupted", not "running".
 * @param store - Where the results go.
 * @param finished - What the results are summed up from, besides the records.
 * @param ran - What `runAll` returned, and what to do once `results.json` is written.
 * @param ran.records - The finished runs.
 * @param ran.stopped - Why the command stopped early, or null.
 * @param ran.after - Called with the results and the exit code once `results.json` is written; it writes the reports.
 *   When it throws, both files are written again saying "error" and the error goes on.
 * @returns The results that were written.
 */
export function finalWrite(
  store: Store,
  finished: Omit<
    Finished,
    "records" | "sourceChanged" | "partial" | "subjects"
  > & { subjects: Subject[] },
  ran: {
    records: RunRecord[];
    stopped: StopReason | null;
    after: (results: Results, exit: ExitCode) => void;
  },
): Results {
  const { records, stopped, after } = ran;
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
    const results = summarize({
      ...finished,
      records,
      sourceChanged: changedAtSource(finished.subjects),
      partial: stopped === null ? null : { reason: stopped },
    });
    store.flush(results);
    const exit = exitCodeOf(results, finished.maxInvalid);
    try {
      after(results, exit);
    } catch (error) {
      const failed = { ...results, partial: { reason: "error" as const } };
      writeLast(store, failed, finished.maxInvalid);
      throw error;
    }
    store.writeSummary(summaryOf(results, exit));
    return results;
  } finally {
    off();
  }
}

/**
 * Removes the `summary.json` and the reports that an earlier command left in the output directory, so that none of
 * them is taken for this command's.
 * @param outDir - The output directory.
 */
export function clearStale(outDir: string): void {
  for (const file of ["summary.json", NOISE_FILE, ...Object.values(FORMATS)]) {
    if (file !== null) fs.rmSync(path.join(outDir, file), { force: true });
  }
}

/**
 * Leaves a summary for a command that failed before it could write one: exit 5, no suites. A command that stopped on a
 * usage error, or already wrote its summary, is left alone.
 * @param outDir - The output directory.
 * @param error - What the command threw.
 */
export function noteFailure(outDir: string, error: unknown): void {
  const file = path.join(outDir, "summary.json");
  if (error instanceof UsageError || fs.existsSync(file)) return;
  const summary: Summary = {
    schemaVersion: 1,
    exit: EXIT.error,
    suites: [],
    belowBar: [],
    invalid: 0,
    notApplicable: 0,
    partial: "error",
    costUsd: null,
    durationMs: 0,
  };
  try {
    fs.writeFileSync(file, JSON.stringify(summary, null, "\t"));
  } catch {
    // The directory cannot be written: the error that is thrown says so.
  }
}

/**
 * Makes what `evaluate` returns from the results.
 * @param results - What was written to `results.json`.
 * @param context - What `prepare` settled.
 * @param where - The output directory, and the exit code from `exitCodeOf`.
 * @param where.outDir - Where the files of the command are.
 * @param where.exit - The code the command exits with.
 * @returns What `evaluate` returns: the results, the exit code, the cases and where they ran.
 */
export const evaluationOf = (
  results: Results,
  context: Context,
  where: { outDir: string; exit: ExitCode },
): Evaluation => ({
  ...results,
  exit: where.exit,
  cases: context.cases,
  applied: context.parts.ran,
  outDir: where.outDir,
});
