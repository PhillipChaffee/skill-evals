import type { Case } from "../cases.js";
import type { Evaluation } from "../evaluate.js";

/** The label of the only subject of an evaluation made here. */
const SUBJECT = "subject";

/** A check result with only what the trigger table reads. */
export interface Result {
  type: string;
  skill?: string;
  anyOf?: string[];
  score: number | null;
}

/** A run record with only what the trigger table reads. */
export interface Run {
  caseId: string;
  harness: string;
  rep: number;
  subject: string;
  error: string | null;
  checks: Result[];
  unexpected: string[];
  isolated: boolean;
}

/**
 * Makes a case with only what the trigger table reads.
 * @param id - What the run records name the case by.
 * @param more - Any of its kind, its targets and its held-out flag.
 * @returns A case that has the given keys and is otherwise empty.
 */
export const caseOf = (id: string, more: Partial<Case>): Case =>
  ({ id, targets: [], heldout: false, ...more }) as Case;

/**
 * Makes a run record, valid unless `error` is set.
 * @param where - The case and the harness it ran under.
 * @param where.caseId - Which case the run was of.
 * @param where.harness - Which harness ran it.
 * @param checks - What each check scored.
 * @param error - Why the run failed; null for a run that did not.
 * @returns The record.
 */
export const runOf = (
  where: { caseId: string; harness: string },
  checks: Result[],
  error: string | null = null,
): Run => ({
  ...where,
  rep: 1,
  subject: SUBJECT,
  error,
  checks,
  unexpected: [],
  isolated: false,
});

/**
 * Makes the part of an evaluation that the trigger table reads.
 * @param harnesses - Which harnesses ran.
 * @param cases - What was loaded.
 * @param records - What the runs gave.
 * @returns An evaluation that is otherwise empty.
 */
export const evaluationOf = (
  harnesses: string[],
  cases: Case[],
  records: Run[],
): Evaluation =>
  ({ harnesses, cases, records, barSubject: SUBJECT }) as unknown as Evaluation;
