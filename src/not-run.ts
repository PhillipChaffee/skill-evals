import type { Case } from "./cases.js";
import type { RunRecord } from "./run.js";
import { slotsOf } from "./slots.js";

/** A run of the plan that has no valid finished record: it was not started, or it was started and its graders were skipped. */
export interface NotRun {
  harness: string;
  caseId: string;
  subject: string;
  rep: number;
}

/**
 * Lists every run of the plan, in plan order.
 * @param plan - What was planned.
 * @param plan.harnesses - The harness ids.
 * @param plan.applied - For each harness id, the cases it runs.
 * @param plan.reps - The default number of reps; a case's own `reps` wins.
 * @param plan.labels - The subject labels.
 * @returns One entry for each run.
 */
export const plannedRuns = (plan: {
  harnesses: string[];
  applied: Record<string, Case[]>;
  reps: number;
  labels: string[];
}): NotRun[] =>
  slotsOf({
    chosen: plan.harnesses.map((id) => ({ harness: { id } })),
    applied: plan.applied,
    reps: plan.reps,
    subjects: plan.labels,
  }).map(({ located, caseDef, rep, subject }) => ({
    harness: located.harness.id,
    caseId: caseDef.id,
    subject,
    rep,
  }));

/**
 * Finds the runs that did not run: those with no record, and those whose graders were skipped.
 * @param planned - Every run of the plan.
 * @param records - The records that exist.
 * @returns The runs without a finished record, in plan order.
 */
export function notRunOf(planned: NotRun[], records: RunRecord[]): NotRun[] {
  const finished = new Set(
    records
      .filter((record) => record.skippedGraders !== true)
      .map((record) => slotOf(record)),
  );
  return planned.filter((each) => !finished.has(slotOf(each)));
}

const slotOf = (run: NotRun | RunRecord): string =>
  [run.harness, run.caseId, run.subject, run.rep].join("\n");
