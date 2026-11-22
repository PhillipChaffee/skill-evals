import fs from "node:fs";
import path from "node:path";
import type { EvaluateOptions } from "../evaluate.js";
import type { Context, Prepared } from "../prepare.js";
import { basePlan, prepare, resolveAll } from "../prepare.js";
import type { Project } from "../project.js";
import type { RunRecord } from "../run.js";
import { invalidReason } from "../run.js";
import type { Planned } from "../run-loop.js";
import { runsOf } from "../run-loop.js";
import { UsageError, messageOf } from "../scope.js";
import type { StoredRun } from "../store.js";
import { RUNS_FILE, readRuns, recordOf, reusable, slotName } from "../store.js";
import type { Subject } from "../subject.js";
import { subjectsOf } from "./subjects.js";
import type { Options } from "../usage.js";
import { estimateOf, renderEstimate } from "./plan-estimate.js";

/** What `planText` takes: the options of a run or score command line. */
type PlanOptions = Omit<EvaluateOptions, "onRun" | "onWarning">;

/** What an earlier command left in an output directory. */
interface Prior {
  /** The valid records, the last of each run; invalid and superseded lines are left out. */
  records: RunRecord[];
  /** What a resume would reuse; null when there is no `results.jsonl`, so no key can be compared. */
  reusable: Map<string, RunRecord> | null;
}

/**
 * Keeps the valid records of a list, the last of each run.
 * @param all - Records in the order they were made.
 * @returns The records that count as valid runs. The last record of each run is taken first, so that a valid record
 *   that a later invalid one replaced does not count.
 */
function validOnes(all: RunRecord[]): RunRecord[] {
  const last = new Map<string, RunRecord>();
  for (const record of all) {
    last.set(
      `${record.harness}\n${record.caseId}\n${record.subject}\n${String(record.rep)}`,
      record,
    );
  }
  return [...last.values()].filter(
    (record) => Array.isArray(record.checks) && invalidReason(record) === null,
  );
}

/**
 * Reads what an earlier command left in an output directory.
 * @param dir - The directory.
 * @returns The records of `results.jsonl`, else those of `results.json`; null when the directory holds neither.
 * @throws {UsageError} When `results.jsonl` or `results.json` cannot be read as results.
 */
function priorOf(dir: string): Prior | null {
  if (fs.existsSync(path.join(dir, RUNS_FILE))) {
    const { lines }: { lines: StoredRun[] } = readRuns(dir);
    return {
      records: validOnes(lines.map(recordOf)),
      reusable: reusable(lines),
    };
  }
  const file = path.join(dir, "results.json");
  if (!fs.existsSync(file)) return null;
  try {
    const { records } = JSON.parse(fs.readFileSync(file, "utf8")) as {
      records: RunRecord[];
    };
    return { records: validOnes(Array.from(records)), reusable: null };
  } catch (error) {
    throw new UsageError(
      `${file}: cannot be read as results: ${messageOf(error)}`,
    );
  }
}

/**
 * Words how many runs a harness has.
 * @param prepared - What `prepare` returned.
 * @param id - The harness id.
 * @param subjects - The number of subjects.
 * @returns The line of the matrix: cases, subjects, reps, runs. Reps is a range when cases set their own.
 */
function matrixLine(prepared: Prepared, id: string, subjects: number): string {
  const { context } = prepared;
  const own = context.parts.ran[id] ?? [];
  const reps = own.map((one) => one.reps ?? context.reps);
  const low = Math.min(...reps);
  const high = Math.max(...reps);
  const shown = low === high ? String(low) : `${String(low)}-${String(high)}`;
  const runs = reps.reduce((sum, each) => sum + each, 0) * subjects;
  return `- ${id}: ${String(own.length)} cases x ${String(subjects)} subjects x ${shown} reps = ${String(runs)} runs`;
}

/**
 * Words the estimate for the runs that a resume would make.
 * @param what - What was planned and what an earlier command left.
 * @param what.prior - The earlier command's records and directory; null when there are none.
 * @param what.planned - Every run of the plan.
 * @param what.left - The runs that a resume would not reuse.
 * @param what.context - What `prepare` settled; the jobs divide the duration.
 * @returns The lines, after a blank line; none without a prior directory.
 */
function estimateLines(what: {
  prior: { earlier: Prior; dir: string } | null;
  planned: Planned[];
  left: Planned[];
  context: Context;
}): string[] {
  const { prior, planned, left, context } = what;
  if (prior === null) return [];
  const { earlier, dir } = prior;
  const reuse = earlier.reusable;
  const estimate = estimateOf(
    earlier.records,
    left.map(({ run }) => ({
      harness: run.harness.id,
      caseId: run.caseDef.id,
    })),
    context.jobs,
  );
  const reused =
    reuse === null
      ? null
      : { count: planned.length - left.length, of: planned.length };
  return ["", ...renderEstimate(estimate, { dir, jobs: context.jobs, reused })];
}

/**
 * Describes what a run or score command would do. It starts no harness process and writes nothing to the output
 * directory; it looks harnesses up on `PATH`, and exports each subject to a temp directory to key the runs. It raises
 * every usage error that the command would.
 * @param given - The options of the command, with its subjects.
 * @param inspect - True for `plan`, which may read the output directory of an earlier command.
 * @returns The matrix of harnesses, cases, subjects and reps, the number of runs, the pairs that are not applicable,
 *   and, when `resume` or `outDir` names a directory with an earlier command's results, how many runs a resume would
 *   reuse and an estimate of cost and duration for the rest.
 * @throws {UsageError} For a wrong option, subject or case file, as the command itself would.
 */
function planText(given: PlanOptions, inspect: boolean): string {
  const prepared = prepare(given, { inspect });
  const { context, pairs } = prepared;
  const subjects: Subject[] = [];
  try {
    resolveAll(prepared, subjects);
    const prior = context.resumed ?? context.options.outDir;
    const dir = prior === undefined ? null : path.resolve(context.cwd, prior);
    const earlier = dir === null ? null : priorOf(dir);
    const planned = runsOf(basePlan(context, subjects, dir ?? ""));
    const reuse = earlier?.reusable ?? null;
    const left = planned.filter(
      ({ key, subject }) => reuse?.has(slotName(key, subject.label)) !== true,
    );
    const harnesses = context.selection.chosen.map(({ harness }) => harness.id);
    const { notApplicable } = context.parts;
    return [
      `Harnesses (${String(harnesses.length)}): ${harnesses.join(", ")} (${context.selection.reason})`,
      `Subjects (${String(pairs.length)}): ${pairs.map(({ label, spec }) => `${label} = ${spec}`).join(", ")}`,
      `Cases: ${String(context.cases.length)} loaded, ${String(context.reps)} reps each unless a case says its own`,
      "",
      "Matrix (harness x case x subject x reps):",
      ...harnesses.map((id) => matrixLine(prepared, id, pairs.length)),
      "",
      `Runs: ${String(planned.length)}`,
      ...(notApplicable.length === 0
        ? []
        : [
            "",
            "Not applicable (no runs, no score):",
            ...notApplicable.map(
              ({ harness, caseId, reason }) =>
                `- ${harness} ${caseId}: ${reason}`,
            ),
          ]),
      ...estimateLines({
        prior: earlier === null || dir === null ? null : { earlier, dir },
        planned,
        left,
        context,
      }),
    ].join("\n");
  } finally {
    for (const subject of subjects) subject.dispose();
  }
}

/**
 * Prints the plan of a command line.

 * @param given - The options and subjects of the command.
 * @param inspect - True for `plan`, which may name the directory of an earlier command to read it; false for
 *   `--dry-run`, which raises the usage errors about the output directory that the command would.
 * @returns 0.
 */
export function printPlan(given: PlanOptions, inspect: boolean): number {
  console.log(planText(given, inspect));
  return 0;
}

/**
 * The `plan` command: prints what a `run` or `score` with the same options would make, and spends nothing.
 * @param options - The command line's options.
 * @param project - Where the config file and the default cases directory are.
 * @returns 0.
 */
export function plan(options: Options, project: Project): number {
  const { a, b, subject, subjects, ...rest } = options;
  const given = subjectsOf({ a, b, subject, subjects }, project, true);
  return printPlan({ ...rest, ...given, cwd: project.cwd }, true);
}
