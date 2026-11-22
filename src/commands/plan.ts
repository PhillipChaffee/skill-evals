import fs from "node:fs";
import path from "node:path";
import { partitionApplicable } from "../applicability.js";
import type { EvaluateOptions } from "../evaluate.js";
import {
  casesOf,
  labelled,
  requireJobs,
  requireUsable,
} from "../evaluate-setup.js";
import { selectHarnesses } from "../harnesses/index.js";
import type { Project } from "../project.js";
import { withConfig } from "../project.js";
import { resumeDir } from "../resume.js";
import type { RunRecord } from "../run.js";
import { slotsOf } from "../run-loop.js";
import { UsageError, messageOf } from "../scope.js";
import { RUNS_FILE, readRuns, recordOf } from "../store.js";
import type { Options } from "../usage.js";
import { estimateOf, renderEstimate } from "./plan-estimate.js";

/** What `planText` takes: the options of a run or score command line. */
type PlanOptions = Omit<EvaluateOptions, "onRun" | "onWarning">;

/**
 * Reads the records of an earlier command in an output directory.
 * @param dir - The directory.
 * @returns The records of `results.jsonl`, else those of `results.json`; null when the directory holds neither.
 * @throws {UsageError} When `results.jsonl` or `results.json` cannot be read as results.
 */
function priorRecords(dir: string): RunRecord[] | null {
  if (fs.existsSync(path.join(dir, RUNS_FILE))) {
    return readRuns(dir).lines.map(recordOf);
  }
  const file = path.join(dir, "results.json");
  if (!fs.existsSync(file)) return null;
  try {
    const { records } = JSON.parse(fs.readFileSync(file, "utf8")) as {
      records: RunRecord[];
    };
    return Array.from(records);
  } catch (error) {
    throw new UsageError(
      `${file}: cannot be read as results: ${messageOf(error)}`,
    );
  }
}

/**
 * Describes what a run or score command would do. It starts no harness process and writes nothing; it looks harnesses
 * up on `PATH` only.
 * @param given - The options of the command, with its subjects.
 * @param project - Where the config file and the default cases directory are.
 * @returns The matrix of harnesses, cases, subjects and reps, the number of runs, the pairs that are not applicable,
 *   and, when `resume` or `outDir` names a directory with an earlier command's results, an estimate of cost and duration.
 * @throws {UsageError} For a wrong option or case file, as the command itself would.
 */
function planText(given: PlanOptions, project: Project): string {
  const { cwd = project.cwd, subjects: specs, ...rest } = given;
  const options = withConfig(project, rest);
  const reps = requireUsable(options);
  const jobs = requireJobs(options);
  const prior = resumeDir(options, cwd) ?? options.outDir;
  const selection = selectHarnesses(options.harness);
  const cases = casesOf(options);
  const parts = partitionApplicable(selection.chosen, cases);
  const pairs = labelled(specs);
  const slots = slotsOf({
    chosen: selection.chosen,
    applied: parts.ran,
    reps,
    subjects: pairs,
  });
  const harnesses = selection.chosen.map(({ harness }) => harness.id);
  const priorDir = prior === undefined ? null : path.resolve(cwd, prior);
  const earlier = priorDir === null ? null : priorRecords(priorDir);
  return [
    `Harnesses (${String(harnesses.length)}): ${harnesses.join(", ")} (${selection.reason})`,
    `Subjects (${String(pairs.length)}): ${pairs.map(({ label, spec }) => `${label} = ${spec}`).join(", ")}`,
    `Cases: ${String(cases.length)} loaded, ${String(reps)} reps each unless a case says its own`,
    "",
    "Matrix (harness x case x subject x reps):",
    ...harnesses.map((id) => {
      const mine = slots.filter(({ located }) => located.harness.id === id);
      const own = parts.ran[id] ?? [];
      return `- ${id}: ${String(own.length)} cases x ${String(pairs.length)} subjects = ${String(mine.length)} runs`;
    }),
    "",
    `Runs: ${String(slots.length)}`,
    ...(parts.notApplicable.length === 0
      ? []
      : [
          "",
          "Not applicable (no runs, no score):",
          ...parts.notApplicable.map(
            ({ harness, caseId, reason }) =>
              `- ${harness} ${caseId}: ${reason}`,
          ),
        ]),
    ...(earlier === null
      ? []
      : [
          "",
          ...renderEstimate(
            estimateOf(
              earlier,
              slots.map(({ located, caseDef }) => ({
                harness: located.harness.id,
                caseId: caseDef.id,
              })),
              jobs,
            ),
            { dir: priorDir ?? "", jobs },
          ),
        ]),
  ].join("\n");
}

/**
 * Prints the plan of a command line.
 * @param given - The options and subjects of the command.
 * @param project - Where the config file and the default cases directory are.
 * @returns 0.
 */
export function printPlan(given: PlanOptions, project: Project): number {
  console.log(planText(given, project));
  return 0;
}

/**
 * The `plan` command: prints what a `run` or `score` with the same options would make, and spends nothing.
 * @param options - The command line's options.
 * @param project - Where the config file and the default cases directory are.
 * @returns 0.
 */
export function plan(options: Options, project: Project): number {
  const { a, b, subject, ...rest } = options;
  const subjects =
    a === undefined && b === undefined
      ? [subject ?? project.root]
      : [a ?? "main", b ?? project.root];
  return printPlan({ ...rest, subjects }, project);
}
