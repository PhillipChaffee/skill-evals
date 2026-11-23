import type { Case } from "../cases.js";
import type { Evaluation } from "../evaluate.js";
import { invalidReason } from "../run.js";
import type { RunRecord } from "../run.js";
import { formatScore } from "../score.js";

const RECALL_CHECK = "skill_loaded";
const FALSE_CHECK = "skill_not_loaded";
const DECIMALS = 2;
const ONE_HARNESS = 1;
/** The column titles of the table, after the skill's. */
const TRIGGER_HEAD = [
  "trigger recall (dev)",
  "trigger recall (held-out)",
  "gap",
  "false-trigger rate",
];

/** One number of the table, with the runs behind it. */
interface TriggerCell {
  /** The number, or null when no valid run has the check. */
  value: number | null;
  /** The valid runs that count. */
  runs: number;
}

/** What the table says of one target skill under one harness. */
export interface TriggerRow {
  harness: string;
  skill: string;
  /** The mean score of the `skill_loaded` checks on the skill, over the runs of `trigger` cases that are not held out. */
  recallDev: TriggerCell;
  /** The same over the held-out `trigger` cases. */
  recallHeldout: TriggerCell;
  /** `recallDev` minus `recallHeldout`; null when either has no valid run. */
  gap: number | null;
  /** The share of the valid runs of `negative` cases whose `skill_not_loaded` check on the skill scored 0. */
  falseTrigger: TriggerCell;
}

/** What the runs of one skill and one bucket add up to. */
interface Tally {
  /** The runs that count, as `<case id>#<rep>`. */
  runs: Set<string>;
  /** The scores of the checks. */
  scores: number[];
  /** The runs in which a check scored 0. */
  zeros: Set<string>;
}

const emptyTally = (): Tally => ({
  runs: new Set(),
  scores: [],
  zeros: new Set(),
});

/**
 * Names the skills a check counts for.
 * @param check - A `skill_loaded` or `skill_not_loaded` result.
 * @param check.skill - The skill the check names, if any.
 * @param check.anyOf - The skills the check names as a list, if any.
 * @param caseDef - The case the check is in.
 * @returns The check's own skill; for a list, each named skill that the case also targets, and never a target the
 *   list leaves out; for a check that names none, the targets of the case.
 */
function skillsOf(
  check: { skill?: string; anyOf?: string[] },
  caseDef: Case,
): string[] {
  if (check.anyOf !== undefined) {
    return check.anyOf.filter((name) => caseDef.targets.includes(name));
  }
  return check.skill === undefined ? caseDef.targets : [check.skill];
}

/**
 * Adds the checks of one valid run to the tallies.
 * @param tallies - The tallies, keyed by harness, skill and bucket.
 * @param record - A valid run.
 * @param caseDef - The run's case, of kind `trigger` or `negative`.
 */
function addRun(
  tallies: Map<string, Tally>,
  record: RunRecord,
  caseDef: Case,
): void {
  const trigger = caseDef.kind === "trigger";
  const bucket = !trigger ? "false" : caseDef.heldout ? "held" : "dev";
  const wanted = trigger ? RECALL_CHECK : FALSE_CHECK;
  for (const check of record.checks) {
    if (check.type !== wanted || check.score === null) continue;
    for (const skill of skillsOf(check, caseDef)) {
      const key = JSON.stringify([record.harness, skill, bucket]);
      const tally = tallies.get(key) ?? emptyTally();
      const run = `${record.caseId}#${String(record.rep)}`;
      tally.runs.add(run);
      tally.scores.push(check.score);
      if (check.score === 0) tally.zeros.add(run);
      tallies.set(key, tally);
    }
  }
}

/**
 * Makes one cell from a tally.
 * @param tally - What was counted; absent when nothing was.
 * @param share - True for the share of runs with a zero; false for the mean score.
 * @returns The value over the tally's runs, with how many there are.
 */
function cellOf(tally: Tally | undefined, share: boolean): TriggerCell {
  if (tally === undefined || tally.runs.size === 0) {
    return { value: null, runs: 0 };
  }
  const value = share
    ? tally.zeros.size / tally.runs.size
    : tally.scores.reduce((sum, score) => sum + score, 0) / tally.scores.length;
  return { value, runs: tally.runs.size };
}

/**
 * Works out the trigger table: for each target skill, how often its skill is loaded when it should be, on the
 * development prompts and on the held-out ones, and how often it is loaded when it should not be. The runs are those of
 * the subject under test, which the pass bars apply to.
 * @param evaluation - What `evaluate` returned.
 * @returns One row for each harness and target skill, sorted by harness and skill; empty when no case names a target.
 */
export function triggerRows(evaluation: Evaluation): TriggerRow[] {
  const byId = new Map(evaluation.cases.map((one) => [one.id, one]));
  const tallies = new Map<string, Tally>();
  for (const record of evaluation.records) {
    const caseDef = byId.get(record.caseId);
    if (
      caseDef === undefined ||
      record.subject !== evaluation.barSubject ||
      invalidReason(record) !== null ||
      (caseDef.kind !== "trigger" && caseDef.kind !== "negative")
    ) {
      continue;
    }
    addRun(tallies, record, caseDef);
  }
  const skills = [
    ...new Set(evaluation.cases.flatMap(({ targets }) => targets)),
  ].sort();
  return evaluation.harnesses.flatMap((harness) =>
    skills.map((skill): TriggerRow => {
      const at = (bucket: string): Tally | undefined =>
        tallies.get(JSON.stringify([harness, skill, bucket]));
      const recallDev = cellOf(at("dev"), false);
      const recallHeldout = cellOf(at("held"), false);
      return {
        harness,
        skill,
        recallDev,
        recallHeldout,
        gap:
          recallDev.value === null || recallHeldout.value === null
            ? null
            : recallDev.value - recallHeldout.value,
        falseTrigger: cellOf(at("false"), true),
      };
    }),
  );
}

/**
 * Words a cell for a table.
 * @param cell - A value of the table and its run count.
 * @returns The number with two decimals and its run count, as in `0.83 (6 runs)`; `n/a (0 runs)` for none.
 */
const cellText = (cell: TriggerCell): string =>
  `${formatScore(cell.value)} (${String(cell.runs)} ${cell.runs === 1 ? "run" : "runs"})`;

/**
 * Words the gap for a table.
 * @param gap - Dev minus held-out, or null.
 * @returns The gap with a sign and two decimals, or `n/a`.
 */
export function gapText(gap: number | null): string {
  if (gap === null) return "n/a";
  const text = gap.toFixed(DECIMALS);
  if (text === "-0.00" || text === "0.00") return "0.00";
  return gap > 0 ? `+${text}` : text;
}

/** The trigger table as text: its column titles and a row of cells for each skill. */
export interface TriggerTable {
  head: string[];
  body: string[][];
}

/**
 * Lays the trigger table out for a report. The cells are the same in every format.
 * @param evaluation - What `evaluate` returned.
 * @returns The titles and the rows, with a harness column only when more than one harness ran; null when no case
 *   names a target, so that there is no table.
 */
export function triggerTable(evaluation: Evaluation): TriggerTable | null {
  const rows = triggerRows(evaluation);
  if (rows.length === 0) return null;
  const withHarness = evaluation.harnesses.length > ONE_HARNESS;
  const lead = (row: TriggerRow): string[] =>
    withHarness ? [row.harness, row.skill] : [row.skill];
  return {
    head: [...(withHarness ? ["harness"] : []), "skill", ...TRIGGER_HEAD],
    body: rows.map((row) => [
      ...lead(row),
      cellText(row.recallDev),
      cellText(row.recallHeldout),
      gapText(row.gap),
      cellText(row.falseTrigger),
    ]),
  };
}

/**
 * Words the heading of the trigger table.
 * @param evaluation - What `evaluate` returned.
 * @returns The heading; with more than one subject it names the one whose runs the table shows.
 */
export const triggerHeading = (evaluation: Evaluation): string =>
  evaluation.subjects.length > ONE_HARNESS
    ? `Trigger recall by target skill (subject ${evaluation.barSubject})`
    : "Trigger recall by target skill";
