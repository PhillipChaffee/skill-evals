import type { Partition } from "./applicability.js";
import { partitionApplicable } from "./applicability.js";
import type { Case } from "./cases.js";
import type { DecisionService } from "./decision.js";
import type { EvaluateOptions } from "./evaluate.js";
import {
  casesOf,
  decisionFor,
  labelled,
  requireJobs,
  requireUsable,
} from "./evaluate-setup.js";
import { exclusionsOf } from "./exclusions.js";
import type { Located } from "./harnesses/index.js";
import { requireIsolatedRun, selectHarnesses } from "./harnesses/index.js";
import type { JudgeApi } from "./judge-api.js";
import { judgeHarnessOf, judgeSetup } from "./judge-config.js";
import type { Config, Project } from "./project.js";
import { findProject, withConfig } from "./project.js";
import { resumeDir } from "./resume.js";
import { modesOf } from "./run.js";
import type { PlanBase } from "./run-loop.js";
import { requireSupportedPlatform } from "./scope.js";
import type { Label, Subject } from "./subject.js";
import { resolveSubject } from "./subject.js";

/** What a command settles before it resolves any subject. */
export interface Context {
  options: Config & { cases: string } & Pick<
      EvaluateOptions,
      "outDir" | "useCache"
    >;
  decision: DecisionService | null;
  decisionModel: string | undefined;
  selection: { chosen: Located[]; reason: string };
  judgeHarness: Located | undefined;
  judgeModel: string | undefined;
  judgeApi: JudgeApi | null;
  model: string | undefined;
  minScore: number | undefined;
  reps: number;
  cases: Case[];
  parts: Partition;
  jobs: number;
  /** The directory of the earlier command to continue; undefined for a fresh run. */
  resumed: string | undefined;
  cwd: string;
}

/** What `prepare` returns. */
export interface Prepared {
  context: Context;
  project: Project;
  pairs: { label: Label; spec: string }[];
}

/**
 * Settles everything that can be wrong with a command line before any harness starts or any file is written.
 * @param given - The options of `run` or `score`, as `evaluate` takes them.
 * @returns What the command works with.
 * @throws {UsageError} For a wrong option, case file, config file or harness.
 */
export function prepare(given: Omit<EvaluateOptions, "onRun">): Prepared {
  const { cwd = process.cwd(), subjects: specs, ...rest } = given;
  requireSupportedPlatform();
  const pairs = labelled(specs);
  const project = findProject(cwd);
  const options = withConfig(project, rest);
  const reps = requireUsable(options);
  const jobs = requireJobs(options);
  const resumed = resumeDir(options, cwd);
  const selection = selectHarnesses(options.harness);
  const judgeHarness = judgeHarnessOf(options);
  if (options.isolated) requireIsolatedRun(selection.chosen, judgeHarness);
  const cases = casesOf(options);
  const { judgeApi, judgeModel } = judgeSetup(cases, options);
  const context: Context = {
    options,
    decision: decisionFor(cases, options),
    decisionModel: options.decisionModel,
    selection,
    judgeHarness,
    judgeModel,
    judgeApi,
    model: options.model,
    minScore: options.minScore,
    reps,
    jobs,
    resumed,
    cwd,
    cases,
    parts: partitionApplicable(selection.chosen, cases),
  };
  return { context, project, pairs };
}

/**
 * Resolves the subjects of a command. Each is exported to a temp directory.
 * @param prepared - What `prepare` returned.
 * @param into - Receives each subject as it is resolved, so that the caller can dispose of those that were made when a
 *   later one fails.
 * @throws {UsageError} When a subject cannot be found or loaded, or the cases or output directory is, or contains, it.
 *   The output directory is the one the command writes to: with `resume`, that directory.
 */
export function resolveAll(prepared: Prepared, into: Subject[]): void {
  const { context, project, pairs } = prepared;
  const { options, cwd } = context;
  const left = exclusionsOf(
    { ...options, outDir: context.resumed ?? options.outDir },
    cwd,
  );
  for (const { label, spec } of pairs) {
    into.push(resolveSubject(label, spec, { ...project, left }));
  }
}

/**
 * Gathers what the runs of a command are made from.
 * @param context - What `prepare` settled.
 * @param subjects - The resolved subjects.
 * @param outDir - The output directory.
 * @returns The plan, without the parts that only a command that runs needs.
 */
export const basePlan = (
  context: Context,
  subjects: Subject[],
  outDir: string,
): PlanBase => ({
  chosen: context.selection.chosen,
  judgeOf: (located) => ({
    ...(context.judgeHarness ?? located),
    model: context.judgeModel,
  }),
  decision: context.decision,
  decisionModel: context.options.decisionModel,
  decisionUrl: context.options.decisionUrl,
  judgeApi: context.judgeApi,
  pass: context.options.env,
  applied: context.parts.ran,
  reps: context.reps,
  subjects,
  model: context.model,
  isolated: modesOf(context.options).isolated,
  lenient: modesOf(context.options).lenient,
  outDir,
  jobs: context.jobs,
});
