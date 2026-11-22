import fs from "node:fs";
import path from "node:path";
import { connect } from "./baseten.js";
import type { CaseMeta } from "./case-meta.js";
import { metaOf } from "./case-meta.js";
import type { Case } from "./cases.js";
import { isDecision } from "./checks/index.js";
import type { DecisionService } from "./decision.js";
import type { Located } from "./harnesses/index.js";
import { requireIsolatedRun, selectHarnesses } from "./harnesses/index.js";
import type { Config } from "./project.js";
import { findProject, withConfig } from "./project.js";
import type { Judge, RunRecord } from "./run.js";
import { requireEnvNames } from "./env.js";
import { invalidReason, modesOf, runOnce } from "./run.js";
import type { CommonSet, SuiteScore } from "./score.js";
import { commonSet, failedBars, isUnitScore, scoreSuites } from "./score.js";
import type { SelectionOptions } from "./select.js";
import { loadSelection, selectionOf } from "./select.js";
import { UsageError, outputDir, requireSupportedPlatform } from "./scope.js";
import type { Label, Subject, SubjectSummary } from "./subject.js";
import { changedAtSource, resolveSubject } from "./subject.js";
import { exclusionsOf } from "./exclusions.js";
import type { Partition } from "./applicability.js";
import { partitionApplicable } from "./applicability.js";

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
  /** Called with each run's record as soon as the run ends. */
  onRun?: ((record: RunRecord) => void) | undefined;
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

const DEFAULT_REPS = 3;
const MS_PER_SECOND = 1000;
// The longest time limit a timer takes is 2^32 - 1 milliseconds.
const MAX_TIMEOUT_SECONDS = 4_294_967;

/**
 * Pairs each subject with its label.
 * @param specs - What the caller passed as `subjects`.
 * @returns "subject" for one; "a" for the baseline and "b" for the subject under test for two.
 * @throws {UsageError} When there are not one or two.
 */
function labelled(specs: string[]): { label: Label; spec: string }[] {
  const [first, second, ...more] = Array.isArray(specs) ? specs : [];
  if (first === undefined || more.length > 0) {
    throw new UsageError("subjects must hold one or two subjects");
  }
  return second === undefined
    ? [{ label: "subject", spec: first }]
    : [
        { label: "a", spec: first },
        { label: "b", spec: second },
      ];
}

/**
 * Rejects option values that no run could use, before any harness starts.
 * @param options - The options after the config file was applied.
 * @returns The number of runs for each subject and case.
 * @throws {UsageError} When `reps`, `minScore`, or `decisionTimeout` is out of range.
 */
function requireUsable(options: Config): number {
  const { reps = DEFAULT_REPS, minScore, decisionTimeout: seconds } = options;
  requireEnvNames(options.env ?? [], "env");
  if (!Number.isInteger(reps) || reps < 1) {
    throw new UsageError("reps must be a positive integer");
  }
  if (minScore !== undefined && !isUnitScore(minScore)) {
    throw new UsageError("minScore must be a number from 0 to 1");
  }
  if (
    seconds !== undefined &&
    !(
      Number.isInteger(seconds) &&
      seconds >= 1 &&
      seconds <= MAX_TIMEOUT_SECONDS
    )
  ) {
    throw new UsageError(
      `decisionTimeout must be a positive integer of seconds, at most ${String(MAX_TIMEOUT_SECONDS)}`,
    );
  }
  return reps;
}

/**
 * Connects to the decision model when a case needs one, before any harness starts.
 * @param cases - The cases of the suite.
 * @param options - The options after the config file was applied.
 * @returns The decision model, or null when no case has a decision check.
 * @throws {UsageError} When a case has a decision check and the model or its API key is not set.
 */
function decisionFor(cases: Case[], options: Config): DecisionService | null {
  if (!cases.some((caseDef) => caseDef.checks.some(isDecision))) return null;
  const { decisionModel: model, decisionUrl: url } = options;
  const { decisionTimeout: seconds } = options;
  if (!model) {
    throw new UsageError(
      "a case has a decision check, but no decision model is set: pass --decision-model or set decisionModel in the config file",
    );
  }
  const timeoutMs = seconds === undefined ? undefined : seconds * MS_PER_SECOND;
  return connect({ model, url, env: process.env, timeoutMs });
}

/**
 * Loads the cases the options name.
 * @param options - The options after the config file was applied.
 * @returns The cases that the selection options choose.
 */
const casesOf = (
  options: SelectionOptions &
    Pick<EvaluateOptions, "lenient" | "onWarning"> & { cases: string },
): Case[] =>
  loadSelection(options.cases, selectionOf(options), {
    lenient: options.lenient ?? false,
    ...(options.onWarning && { onWarning: options.onWarning }),
  });

/** The runs to make, in order: for each harness, each case, each rep, each subject. */
interface Plan {
  chosen: Located[];
  judgeOf: (located: Located) => Judge;
  decision: DecisionService | null;
  pass: string[] | undefined;
  /** For each harness id, the cases it runs. */
  applied: Record<string, Case[]>;
  reps: number;
  subjects: Subject[];
  model: string | undefined;
  isolated: boolean;
  lenient: boolean;
  outDir: string;
  onRun: EvaluateOptions["onRun"];
}

/**
 * Makes every run of a plan, one at a time.
 * @param plan - What to run.
 * @returns The records in the order the runs were made.
 */
async function runAll(plan: Plan): Promise<RunRecord[]> {
  const { reps, subjects, model, outDir, decision, pass } = plan;
  const { isolated, lenient } = plan;
  const records: RunRecord[] = [];
  for (const located of plan.chosen) {
    const judge = plan.judgeOf(located);
    for (const caseDef of plan.applied[located.harness.id] ?? []) {
      for (let rep = 1; rep <= (caseDef.reps ?? reps); rep++) {
        for (const subject of subjects) {
          const run = {
            ...located,
            subject,
            caseDef,
            rep,
            model,
            judge,
            decision,
            pass,
            isolated,
            lenient,
            outDir,
          };
          const record = await runOnce(run);
          records.push(record);
          plan.onRun?.(record);
        }
      }
    }
  }
  return records;
}

/** What a finished evaluation is summed up from. */
interface Finished {
  subjects: Subject[];
  selection: { chosen: Located[]; reason: string };
  judgeHarness: Located | undefined;
  judgeModel: string | undefined;
  decisionModel: string | undefined;
  model: string | undefined;
  minScore: number | undefined;
  reps: number;
  cases: Case[];
  parts: Partition;
  records: RunRecord[];
  sourceChanged: string[];
}

/**
 * Scores the runs and sums up what ran.
 * @param finished - The runs and what they were made with.
 * @returns What goes into `results.json`. The pass bars apply to the last subject, which is the one under test.
 */
function summarize(finished: Finished): Results {
  const { subjects, selection, judgeHarness, judgeModel, model } = finished;
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
    judge: `${judgeHarness?.harness.id ?? "the harness under test"}, model ${judgeModel ?? "the harness default"}`,
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
    records,
  };
}

/**
 * Writes `results.json`.
 * @param outDir - The output directory.
 * @param results - What the evaluation found.
 */
function writeResults(outDir: string, results: Results): void {
  fs.writeFileSync(
    path.join(outDir, "results.json"),
    JSON.stringify(results, null, "\t"),
  );
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
  const { cwd = process.cwd(), subjects: specs, onRun, ...rest } = given;
  requireSupportedPlatform();
  const pairs = labelled(specs);
  const project = findProject(cwd);
  const options = withConfig(project, rest);
  const { minScore, model } = options;
  const reps = requireUsable(options);
  const selection = selectHarnesses(options.harness);
  const [judgeHarness] = options.judgeHarness
    ? selectHarnesses(options.judgeHarness).chosen
    : [];
  if (options.isolated) requireIsolatedRun(selection.chosen, judgeHarness);
  const judgeModel = options.judgeModel ?? model;
  const cases = casesOf(options);
  const decision = decisionFor(cases, options);
  const parts = partitionApplicable(selection.chosen, cases);
  const subjects: Subject[] = [];
  try {
    const scope = { ...project, left: exclusionsOf(options, cwd) };
    for (const { label, spec } of pairs) {
      subjects.push(resolveSubject(label, spec, scope));
    }
    const outDir = outputDir(options.outDir, cwd);
    const records = await runAll({
      chosen: selection.chosen,
      judgeOf: (located) => ({
        ...(judgeHarness ?? located),
        model: judgeModel,
      }),
      decision,
      pass: options.env,
      applied: parts.ran,
      reps,
      subjects,
      model,
      ...modesOf(options),
      outDir,
      onRun,
    });
    const results = summarize({
      subjects,
      selection,
      judgeHarness,
      judgeModel,
      decisionModel: options.decisionModel,
      model,
      minScore,
      reps,
      cases,
      parts,
      records,
      sourceChanged: changedAtSource(subjects),
    });
    writeResults(outDir, results);
    return { ...results, cases, applied: parts.ran, outDir };
  } finally {
    for (const subject of subjects) subject.dispose();
  }
}
