import path from "node:path";
import { requireApproved } from "../approval.js";
import type { Evaluation, EvaluateOptions } from "../evaluate.js";
import { evaluate } from "../evaluate.js";
import type { Progress } from "../progress.js";
import { progressText } from "../progress.js";
import type { Project } from "../project.js";
import { withConfig } from "../project.js";
import { emitReports } from "../report/emit.js";
import { reportFormats } from "../report/formats.js";
import type { RunRecord } from "../run.js";
import { invalidReason } from "../run.js";
import { formatScore } from "../score.js";
import { sourceChangedMessage } from "../subject.js";
import { printPlan } from "./plan.js";

// What the progress line of a scored run says when the runner ended it.
const STOPS = {
  agent: "",
  maxTurns: " (stopped at maxTurns)",
  timeout: " (timed out, scored)",
};

/**
 * Words why a command stopped before the end.
 * @param evaluation - What the command made; its `partial` is set.
 * @returns One line: the limit that was reached, how many runs finished, and how to continue.
 */
function stoppedMessage(
  evaluation: Pick<Evaluation, "partial" | "records" | "outDir">,
): string {
  const limit =
    evaluation.partial?.reason === "budget" ? "--max-cost" : "--max-duration";
  return `skill-evals: stopped at ${limit} after ${String(evaluation.records.length)} finished runs; continue with --resume ${evaluation.outDir}`;
}

/**
 * Makes the runs of a command, prints its report to standard output, and prints one line for each finished run to
 * standard error.
 * @param given - What to evaluate.
 * @param project - Where the config file and the default cases directory are.
 * @returns What `evaluate` returned. Its files are written, and the line that names `summary.json` is printed.
 */
export async function execute(
  given: EvaluateOptions,
  project: Project,
): Promise<Evaluation> {
  const onRun = (
    record: RunRecord,
    info: { reused: boolean; progress: Progress },
  ): void => {
    const outcome =
      invalidReason(record) ??
      `score ${formatScore(record.score)}${STOPS[record.stoppedBy ?? "agent"]}`;
    console.error(
      `${record.harness} ${record.caseId} ${record.subject}${String(record.rep)}: ${outcome}${info.reused ? " (reused)" : ""} ${progressText(info.progress)}`,
    );
  };
  const formats = reportFormats(withConfig(project, given));
  const evaluation = await evaluate({
    ...given,
    onRun,
    // Before any harness starts: the prompts of a directory this machine has not seen run with full permissions.
    approve: (what) => requireApproved(what, { yes: given.yes }),
    // Before summary.json, so that a report that cannot be written is an error that the summary says.
    onFinal: (done) => emitReports(done, formats),
  });
  console.error(
    `skill-evals: wrote ${path.join(evaluation.outDir, "summary.json")}`,
  );
  if (evaluation.sourceChanged.length > 0) {
    console.error(
      `skill-evals: ${sourceChangedMessage(evaluation.sourceChanged)}`,
    );
  }
  if (evaluation.partial !== null) console.error(stoppedMessage(evaluation));
  return evaluation;
}

/**
 * Runs the suite, prints its report to standard output, and prints one line for each finished run to standard error.
 * @param options - What to evaluate; with `dryRun`, the plan is printed and nothing runs.
 * @param project - Where the config file and the default cases directory are.
 * @returns The exit code: 0 for `dryRun`; else `evaluation.exit`, from `exitCodeOf`: 4 when `--max-cost` or `--max-duration`
 *   stopped the command, 3 when a subject directory changed or the invalid runs are above `--max-invalid`, 1 when a pass
 *   bar is not reached, else 0.
 */
export async function suite(
  options: EvaluateOptions & { dryRun?: boolean | undefined },
  project: Project,
): Promise<number> {
  const { dryRun, ...given } = options;
  if (dryRun) return printPlan({ ...given, cwd: project.cwd }, false);
  return (await execute(given, project)).exit;
}
