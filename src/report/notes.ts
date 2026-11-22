const MS_PER_SECOND = 1000;
// The flag that each reason of a stopped command names; the other reasons are not stops by a limit.
const LIMIT_FLAGS: Record<string, string | undefined> = {
  budget: "--max-cost",
  duration: "--max-duration",
};
const COST_DECIMALS = 4;
import type { Evaluation } from "../evaluate.js";
import type { RunRecord } from "../run.js";
import { invalidReason } from "../run.js";
import { plannedRuns } from "../not-run.js";

/**
 * Says that the command stopped before the end, and how many runs did not run.
 * @param evaluation - What `evaluate` returned.
 * @returns The section, or nothing for a command that ran to the end. It names the limit, says for each harness and
 *   subject how many runs did not run, and says when the two subjects of a comparison finished different numbers of
 *   runs, so that their scores are not over the same sample.
 */
function partialSection(evaluation: Evaluation): string[] {
  const { partial, notRun } = evaluation;
  if (partial === null) return [];
  const limit = LIMIT_FLAGS[partial.reason];
  if (limit === undefined) return [];
  const labels = evaluation.subjects.map((subject) => subject.label);
  const planned = plannedRuns({
    harnesses: evaluation.harnesses,
    applied: evaluation.applied,
    reps: evaluation.reps,
    labels,
  });
  const count = (runs: { harness: string; subject: string }[], key: string) =>
    runs.filter((run) => `${run.harness} ${run.subject}` === key).length;
  const rows = evaluation.harnesses.flatMap((harness) =>
    labels.map((label) => {
      const key = `${harness} ${label}`;
      const total = count(planned, key);
      const missing = count(notRun, key);
      return { harness, label, total, missing, done: total - missing };
    }),
  );
  const uneven = evaluation.harnesses.filter((harness) => {
    const done = rows.filter((row) => row.harness === harness);
    return done.some((row) => row.done !== done[0]?.done);
  });
  return [
    "",
    "## Stopped early",
    "",
    `The command stopped at ${limit} (${partial.reason}). Scores cover finished runs only; \`results.json\` lists the runs that did not run under \`notRun\`. Continue with \`--resume\`.`,
    "",
    ...rows
      .filter((row) => row.missing > 0)
      .map(
        (row) =>
          `- ${row.harness} ${row.label.toUpperCase()}: ${String(row.missing)} of ${String(row.total)} runs did not run; scores cover finished runs only`,
      ),
    ...uneven.map(
      (harness) =>
        `- ${harness}: the subjects finished different numbers of runs (${rows
          .filter((row) => row.harness === harness)
          .map((row) => `${row.label.toUpperCase()} ${String(row.done)}`)
          .join(", ")}), so the comparison is not over the same reps`,
    ),
  ];
}

/**
 * Says how many runs were retried, and what the failed attempts cost, which the table leaves out.
 * @param evaluation - What `evaluate` returned.
 * @returns The section, or nothing when no run was retried.
 */
function retriedSection(evaluation: Evaluation): string[] {
  const retried = evaluation.records.filter((record) => record.attempts);
  if (retried.length === 0) return [];
  const attempts = retried.flatMap((record) => record.attempts ?? []);
  const costs = attempts.flatMap((attempt) => attempt.costUsd ?? []);
  const seconds =
    attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0) /
    MS_PER_SECOND;
  const lower = costs.length < attempts.length ? "\u2265" : "";
  const cost =
    costs.length === 0
      ? ""
      : `, ${lower}$${costs.reduce((sum, value) => sum + value, 0).toFixed(COST_DECIMALS)}`;
  return [
    "",
    "## Retried runs",
    "",
    `${String(retried.length)} of ${String(evaluation.records.length)} runs were retried. The ${String(attempts.length)} failed attempts took ${seconds.toFixed(1)} s${cost} in total, not counted in the table.`,
  ];
}

/**
 * Lists the pairs of harness and case that were not run.
 * @param evaluation - What `evaluate` returned.
 * @returns The section, or nothing when every case ran on every harness.
 */
function notApplicableSection(evaluation: Evaluation): string[] {
  if (evaluation.notApplicable.length === 0) return [];
  return [
    "",
    "## Not applicable",
    "",
    "These cases did not run. They have no score, and they are neither a pass nor a failure.",
    "",
    ...evaluation.notApplicable.map(
      ({ harness, caseId, reason }) => `- ${harness} \`${caseId}\`: ${reason}`,
    ),
  ];
}

/**
 * Lists the checks that a harness dropped from a case that ran.
 * @param evaluation - What `evaluate` returned.
 * @returns The section, or nothing when no check was skipped.
 */
function skippedSection(evaluation: Evaluation): string[] {
  if (evaluation.skippedChecks.length === 0) return [];
  return [
    "",
    "## Ran with checks skipped",
    "",
    "The score of these cases on that harness is over the checks that stayed, with their weights re-normalized.",
    "",
    ...evaluation.skippedChecks.map(
      ({ harness, caseId, checks, missing }) =>
        `- ${harness} \`${caseId}\`: skipped ${checks.map((check) => `\`${check}\``).join(", ")}, which need ${missing.join(", ")}`,
    ),
  ];
}

/**
 * Lists the cases whose `maxTurns` a harness could not enforce, because it cannot count turns.
 * @param evaluation - What `evaluate` returned.
 * @returns The section, or nothing when every limit that a case set was enforced.
 */
function limitsSection(evaluation: Evaluation): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const record of evaluation.records) {
    const key = `${record.harness}\u0000${record.caseId}`;
    if (record.maxTurnsEnforced !== false || seen.has(key)) continue;
    seen.add(key);
    const limit = evaluation.cases.find(
      (caseDef) => caseDef.id === record.caseId,
    )?.maxTurns;
    lines.push(
      `- ${record.harness} \`${record.caseId}\`: maxTurns ${String(limit)} is not enforced: the harness cannot count turns (no turnGrouping)`,
    );
  }
  return lines.length === 0
    ? []
    : [
        "",
        "## Limits not enforced",
        "",
        "These cases ran with no turn limit on that harness. Only the time limit bounded them.",
        "",
        ...lines,
      ];
}

/**
 * Counts the runs that the runner ended, for each harness and case.
 * @param evaluation - What `evaluate` returned.
 * @returns The section, or nothing when the runner ended no run.
 */
function stoppedSection(evaluation: Evaluation): string[] {
  const groups = new Map<string, RunRecord[]>();
  for (const record of evaluation.records) {
    const key = `${record.harness} \`${record.caseId}\``;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const lines = [...groups].flatMap(([key, runs]) => {
    const at = runs.filter((run) => run.stoppedBy === "maxTurns").length;
    const late = runs.filter(
      (run) => run.stoppedBy === "timeout" && invalidReason(run) === null,
    ).length;
    return [
      ...(at
        ? [
            `- ${key}: ${String(at)} of ${String(runs.length)} runs stopped at maxTurns`,
          ]
        : []),
      ...(late
        ? [
            `- ${key}: ${String(late)} of ${String(runs.length)} runs timed out and were scored (onTimeout: score)`,
          ]
        : []),
    ];
  });
  return lines.length === 0
    ? []
    : ["", "## Stopped by the runner", "", ...lines];
}

/**
 * The report's notes on what did not run as written: the checks that were skipped, the limits that were not enforced,
 * and the cases that were not applicable.
 * @param evaluation - What `evaluate` returned.
 * @returns The sections that apply, in that order; nothing when none does.
 */
export const noteSections = (evaluation: Evaluation): string[] => [
  ...partialSection(evaluation),
  ...retriedSection(evaluation),
  ...skippedSection(evaluation),
  ...limitsSection(evaluation),
  ...stoppedSection(evaluation),
  ...notApplicableSection(evaluation),
];
