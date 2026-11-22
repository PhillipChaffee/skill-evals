import type { Evaluation } from "./evaluate.js";
import type { RunRecord } from "./run.js";
import { invalidReason } from "./run.js";

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
  ...skippedSection(evaluation),
  ...limitsSection(evaluation),
  ...stoppedSection(evaluation),
  ...notApplicableSection(evaluation),
];
