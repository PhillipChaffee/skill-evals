import fs from "node:fs";
import path from "node:path";
import type { Partition } from "./applicability.js";
import { requireTar } from "./archive.js";
import { partitionApplicable } from "./applicability.js";
import type { Case } from "./cases.js";
import type { DecisionService } from "./decision.js";
import type { EvaluateOptions } from "./evaluate.js";
import {
  casesOf,
  decisionFor,
  labelled,
  requireJobs,
  requireDeltaSetup,
  requireMaxInvalid,
  requireUsable,
} from "./evaluate-setup.js";
import type { DeltaSetup } from "./evaluate-setup.js";
import { exclusionsOf } from "./exclusions.js";
import { requireLimits } from "./evaluate-limits.js";
import type { Limits } from "./gate.js";
import type { Located } from "./harnesses/index.js";
import { requireIsolatedRun, selectHarnesses } from "./harnesses/index.js";
import type { JudgeApi } from "./judge-api.js";
import { judgeHarnessOf, judgeSetup } from "./judge-config.js";
import type { Config, Project } from "./project.js";
import { findProject, withConfig } from "./project.js";
import { requireUnlocked } from "./lock.js";
import { reportFormats } from "./report/formats.js";
import { resumeDir } from "./resume.js";
import { requireFresh } from "./store.js";
import { modesOf } from "./run.js";
import type { PlanBase } from "./run-loop.js";
import { requireSupportedPlatform } from "./scope.js";
import type { Label, Subject } from "./subject.js";
import { resolveSubject } from "./subject.js";

/** What a command settles before it resolves any subject. */
export interface Context {
  options: Config & { cases: string } & Pick<
      EvaluateOptions,
      "outDir" | "useCache" | "rateLimitBackoffMs"
    >;
  decision: DecisionService | null;
  decisionModel: string | undefined;
  selection: { chosen: Located[]; reason: string };
  judgeHarness: Located | undefined;
  judgeModel: string | undefined;
  judgeApi: JudgeApi | null;
  model: string | undefined;
  minScore: number | undefined;
  /** What a comparison is judged with: the delta bar, the seed, and the noise file. */
  delta: DeltaSetup;
  /** True when the two subjects are one subject run against itself, as `calibrate` does. */
  shared: boolean;
  /** The share of the planned runs that may be invalid before the command exits 3. */
  maxInvalid: number;
  reps: number;
  cases: Case[];
  parts: Partition;
  jobs: number;
  /** The retries and the cost and time limits. */
  limits: Limits;
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
 * @param look - How the command uses the output directory.
 * @param look.inspect - True for `plan`, which reads the output directory of an earlier command and writes nothing: it
 *   skips the checks of the directory that a command that runs must pass.
 * @returns What the command works with.
 * @throws {UsageError} For a wrong option, case file, config file or harness; for an output directory that a live
 *   command holds; and, without `resume`, for one that already holds runs. `--dry-run` raises these too.
 */
export function prepare(
  given: Omit<EvaluateOptions, "onRun">,
  look: { inspect?: boolean } = {},
): Prepared {
  const { cwd = process.cwd(), subjects: specs, ...rest } = given;
  requireSupportedPlatform();
  const pairs = labelled(specs);
  const project = findProject(cwd);
  const options = withConfig(project, rest);
  const reps = requireUsable(options);
  const jobs = requireJobs(options);
  const maxInvalid = requireMaxInvalid(options);
  reportFormats(options);
  if (options.keepWorkspaces) requireTar();
  const resumed = resumeDir(options, cwd);
  if (look.inspect !== true) requireUsableOut(resumed, options.outDir, cwd);
  const selection = selectHarnesses(options.harness);
  const judgeHarness = judgeHarnessOf(options);
  if (options.isolated) requireIsolatedRun(selection.chosen, judgeHarness);
  const same = given.sameSubject ?? false;
  // A calibration measures noise and holds nothing to a bar, so no bar of a case reaches it.
  const cases = casesOf(options).map((one) =>
    same ? { ...one, minScore: undefined, minDelta: undefined } : one,
  );
  const { judgeApi, judgeModel } = judgeSetup(cases, options);
  const limits = requireLimits(options, {
    chosen: selection.chosen,
    judgeHarness,
    judgeApi,
    cases,
  });
  const context: Context = {
    options,
    decision: decisionFor(cases, options),
    decisionModel: options.decisionModel,
    selection,
    judgeHarness,
    judgeModel,
    judgeApi,
    model: options.model,
    minScore: same ? undefined : options.minScore,
    delta: requireDeltaSetup(options, {
      subjects: pairs.length,
      same,
    }),
    shared: same,
    maxInvalid,
    reps,
    jobs,
    limits,
    resumed,
    cwd,
    cases,
    parts: partitionApplicable(selection.chosen, cases),
  };
  return { context, project, pairs };
}

/**
 * Checks the output directory of a command that runs: first its lock, then, for a fresh command, that it holds no runs.
 * @param resumed - The directory of `--resume`, or undefined.
 * @param outDir - `--out` as given, or undefined for a new temp directory, which is always usable.
 * @param cwd - What a relative `outDir` resolves against.
 * @throws {UsageError} When a live command holds the directory, or a fresh command would empty the runs in it.
 */
function requireUsableOut(
  resumed: string | undefined,
  outDir: string | undefined,
  cwd: string,
): void {
  const dir =
    resumed ?? (outDir === undefined ? undefined : path.resolve(cwd, outDir));
  if (dir === undefined || !fs.existsSync(dir)) return;
  requireUnlocked(dir);
  if (resumed === undefined) requireFresh(dir);
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
    const first = into[0];
    // One export, two labels: the second subject is the first under another name, and removes nothing.
    if (context.shared && first !== undefined) {
      into.push({ ...first, label, dispose: () => undefined });
      continue;
    }
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
  keepWorkspaces: context.options.keepWorkspaces ?? false,
  outDir,
  jobs: context.jobs,
  limits: context.limits,
});
