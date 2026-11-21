import type { Case } from "./cases.js";
import type { Check } from "./checks/index.js";
import { describeCheck, isDecision, isJudged } from "./checks/index.js";
import type { Evaluation } from "./evaluate.js";
import type { RunRecord, Usage } from "./run.js";
import { invalidReason } from "./run.js";
import type { SuiteScore } from "./score.js";
import { formatScore } from "./score.js";
import type { Coverage } from "./select.js";
import { coverageOf } from "./select.js";
import { describeSubject } from "./subject.js";

const MS_PER_SECOND = 1000;
const COST_DECIMALS = 4;
const SHOWN_REASON_LENGTH = 300;

/** A number of a run that the report shows beside the scores. */
interface Metric {
  title: string;
  value: (usage: Usage) => number | null;
  format: (value: number) => string;
}

const METRICS: Metric[] = [
  {
    title: "Duration",
    value: (usage) => usage.durationMs / MS_PER_SECOND,
    format: (v) => `${v.toFixed(1)} s`,
  },
  {
    title: "Input tokens",
    value: (usage) => usage.tokens?.input ?? null,
    format: (v) => String(Math.round(v)),
  },
  {
    title: "Output tokens",
    value: (usage) => usage.tokens?.output ?? null,
    format: (v) => String(Math.round(v)),
  },
  {
    title: "Cost",
    value: (usage) => usage.costUsd,
    format: (v) => `$${v.toFixed(COST_DECIMALS)}`,
  },
];

/**
 * Finds the middle of a set of numbers.
 * @param values - The numbers, in any order.
 * @returns The middle value, the mean of the two middle values for an even count, or null for no values.
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const middle = sorted.slice(
    (sorted.length - 1) >> 1,
    (sorted.length >> 1) + 1,
  );
  return middle.reduce((sum, value) => sum + value, 0) / middle.length;
}

/**
 * Shows one value for each subject, and the change from the first to the second when there are two.
 * @param values - One value for each subject; null is a missing one.
 * @param format - Renders a value, and the size of the change.
 * @returns The cell text, "n/a" when every value is missing.
 */
function versus(
  values: (number | null)[],
  format: (value: number) => string,
): string {
  if (values.every((value) => value === null)) return "n/a";
  const shown = values
    .map((value) => (value === null ? "n/a" : format(value)))
    .join(" / ");
  const [first, second] = values;
  if (first == null || second == null) return shown;
  const delta = second - first;
  return `${shown} (${delta < 0 ? "-" : "+"}${format(Math.abs(delta))})`;
}

/**
 * Sums up how one check went over the valid runs of one subject.
 * @param check - Decides the form: a rule gives pass or fail, a judge or a decision model gives a score.
 * @param index - Its place among the case's checks.
 * @param records - The valid runs.
 * @returns For a deterministic check the share of runs that passed it, for a judged check or a decision check its
 *   mean score.
 */
function checkRate(check: Check, index: number, records: RunRecord[]): string {
  if (records.length === 0) return "n/a";
  const total = records.reduce(
    (sum, record) => sum + (record.checks[index]?.score ?? 0),
    0,
  );
  return isJudged(check) || isDecision(check)
    ? formatScore(total / records.length)
    : `${String(total)}/${String(records.length)}`;
}

/**
 * Reports what a scoring model cost, which the table leaves out.
 * @param title - Names the model's role: the judge, or the decision model.
 * @param judged - What the model cost each run that it scored.
 * @returns The lines to add under the table; none when it scored no run. A metric that any of the runs lacks is left out.
 */
function scorerLine(
  title: string,
  judged: NonNullable<RunRecord["judge"]>[],
): string[] {
  if (judged.length === 0) return [];
  const calls = judged.reduce((total, usage) => total + usage.calls, 0);
  const totals = METRICS.flatMap((metric) => {
    const values = judged.flatMap((usage) => metric.value(usage) ?? []);
    if (values.length < judged.length) return [];
    const total = values.reduce((sum, value) => sum + value, 0);
    return [`${metric.title.toLowerCase()} ${metric.format(total)}`];
  });
  const parts = [`${String(calls)} calls`, ...totals];
  return [
    "",
    `${title}, in total and not counted in the table: ${parts.join(", ")}`,
  ];
}

const cell = (text: string): string => text.replaceAll("|", "\\|");

/** What one harness's section of the report is built from. */
interface Section {
  suite: SuiteScore;
  cases: Case[];
  /** The runs of this harness. */
  records: RunRecord[];
  labels: string[];
}

/**
 * Builds the table row of one case.
 * @param caseDef - The case whose runs the row sums up.
 * @param section - The scores and runs of the harness the row is for.
 * @returns A markdown table row: the case score, each check's rate, and the median of each metric over the valid runs.
 */
function caseRow(caseDef: Case, section: Section): string {
  const { suite, records, labels } = section;
  const tag = (label: string): string =>
    labels.length > 1 ? `${label.toUpperCase()} ` : "";
  const valid = labels.map((label) => ({
    label,
    runs: records.filter(
      (record) =>
        record.caseId === caseDef.id &&
        record.subject === label &&
        !invalidReason(record),
    ),
  }));
  const checks = caseDef.checks.map((check, index) => {
    const rates = valid.map(
      ({ label, runs }) => tag(label) + checkRate(check, index, runs),
    );
    return `\`${describeCheck(check)}\` ${rates.join(", ")}`;
  });
  const scores = suite.cases.find((scored) => scored.id === caseDef.id)?.scores;
  const cells = [
    caseDef.id,
    versus(Object.values(scores ?? {}), formatScore),
    checks.join("<br>"),
    ...METRICS.map((metric) =>
      versus(
        valid.map(({ runs }) =>
          median(runs.flatMap((run) => metric.value(run) ?? [])),
        ),
        metric.format,
      ),
    ),
  ];
  return `| ${cells.map(cell).join(" | ")} |`;
}

// The case, score, and checks columns that stand before the metric columns.
const LEADING_COLUMNS = 3;

/**
 * Builds the part of the report for one harness.
 * @param section - The scores and runs of one harness.
 * @returns A heading, the table of cases, the suite score, what the judge and the decision model cost, and the list
 *   of invalid runs.
 */
function harnessSection(section: Section): string {
  const { suite, cases, records, labels } = section;
  if (suite.applicable === 0) {
    return `## ${suite.harness}\n\nno case applies to ${suite.harness}: ${String(suite.total)} cases not applicable`;
  }
  const heading = (title: string): string =>
    labels.length > 1 ? `${title}, A / B (B - A)` : title;
  const invalid = records.flatMap((record) => {
    const reason = invalidReason(record);
    if (reason === null) return [];
    const shown = reason.replace(/\s+/g, " ").slice(0, SHOWN_REASON_LENGTH);
    return [
      `- ${record.subject.toUpperCase()} \`${record.caseId}\` rep ${String(record.rep)}: ${shown}`,
    ];
  });
  const metricHeadings = METRICS.map((metric) => heading(metric.title));
  const rule = Array<string>(METRICS.length + LEADING_COLUMNS).fill("---");
  const tableOf = (those: Case[]): string[] => [
    `| Case | ${heading("Score")} | Checks | ${metricHeadings.join(" | ")} |`,
    `| ${rule.join(" | ")} |`,
    ...those.map((caseDef) => caseRow(caseDef, section)),
  ];
  const guards = cases.filter((caseDef) => caseDef.guard);
  const others = cases.filter((caseDef) => !caseDef.guard);
  return [
    `## ${suite.harness}`,
    "",
    ...(others.length > 0 || guards.length === 0 ? tableOf(others) : []),
    ...(guards.length > 0
      ? [
          "",
          "### Guard cases",
          "",
          "These cases must keep passing. Their scores count in the suite score like any other.",
          "",
          ...tableOf(guards),
        ]
      : []),
    "",
    `Suite score: ${versus(Object.values(suite.suite), formatScore)} (${String(suite.applicable)} of ${String(suite.total)} cases)`,
    ...scorerLine(
      "Judge",
      records.flatMap((record) => record.judge ?? []),
    ),
    ...scorerLine(
      "Decision model",
      records.flatMap((record) => record.decision ?? []),
    ),
    ...(invalid.length
      ? ["", "Invalid runs, not counted above:", "", ...invalid]
      : []),
  ].join("\n");
}

/**
 * Lays out the coverage of the target skills as a table.
 * @param rows - One row for each target skill.
 * @param heading - The line that names the table.
 * @returns The heading and the table, or a line that says no case names a target.
 */
export function renderCoverage(
  rows: Coverage[],
  heading = "Coverage by target skill",
): string[] {
  if (rows.length === 0) {
    return [heading, "", "No selected case names a target skill."];
  }
  const line = (cells: (string | number)[]): string =>
    `| ${cells.map((each) => cell(String(each))).join(" | ")} |`;
  return [
    heading,
    "",
    line(["skill", "cases", "dev", "held-out", "guards"]),
    line(["---", "---", "---", "---", "---"]),
    ...rows.map((row) =>
      line([row.skill, row.cases, row.dev, row.heldout, row.guards]),
    ),
  ];
}

/**
 * Shows how many of the cases name each target skill.
 * @param evaluation - What `evaluate` returned.
 * @returns The section, or nothing when no case names a target.
 */
function coverageSection(evaluation: Evaluation): string[] {
  const rows = coverageOf(evaluation.cases);
  return rows.length === 0
    ? []
    : ["", ...renderCoverage(rows, "## Coverage by target skill")];
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
 * Shows the score over the cases that apply to every harness, the only score that compares harnesses.
 * @param evaluation - What `evaluate` returned.
 * @returns The section, or nothing for a single harness.
 */
function commonSection(evaluation: Evaluation): string[] {
  const { commonSet } = evaluation;
  if (!commonSet) return [];
  return [
    "",
    "## Common set",
    "",
    `Common set (${String(commonSet.cases.length)} cases: ${commonSet.cases.join(", ") || "none"}). Only these scores compare harnesses.`,
    "",
    ...Object.entries(commonSet.suite).map(
      ([harness, scores]) =>
        `- ${harness}: ${versus(Object.values(scores), formatScore)}`,
    ),
  ];
}

/**
 * Renders an evaluation as the markdown report that the `run` and `score` commands print.
 * @param evaluation - What `evaluate` returned.
 * @returns The report: a title that says whether one subject was scored or two were compared, what ran, one section
 *   for each harness, and the pass bars that were not reached.
 */
export function renderReport(evaluation: Evaluation): string {
  const { subjects, cases, records, belowBar, reps } = evaluation;
  const compared = subjects.length > 1;
  const labels = subjects.map((subject) => subject.label);
  const judged = cases.some((caseDef) => caseDef.checks.some(isJudged));
  const sections = evaluation.suites.map((suite) =>
    harnessSection({
      suite,
      // The cases as this harness ran them, so that a dropped check does not shift the lines of the others.
      cases: evaluation.applied[suite.harness] ?? [],
      records: records.filter((record) => record.harness === suite.harness),
      labels,
    }),
  );
  return [
    compared ? "# Skill comparison" : "# Skill scores",
    "",
    ...subjects.map(
      (subject) =>
        `- ${subject.label.toUpperCase()}: ${describeSubject(subject)}`,
    ),
    `- Harness: ${evaluation.harnesses.join(", ")} (${evaluation.harnessReason})`,
    `- Model: ${evaluation.model ?? "the harness default"}`,
    ...(judged ? [`- Judge: ${evaluation.judge}`] : []),
    ...(evaluation.decisionModel === null
      ? []
      : [`- Decision model: ${evaluation.decisionModel}`]),
    `- Reps: ${String(reps)} for each ${compared ? "subject and case" : "case"}${cases.some((caseDef) => caseDef.reps !== undefined) ? ", unless a case sets its own" : ""}`,
    `- Output: ${evaluation.outDir}`,
    "",
    sections.join("\n\n"),
    ...commonSection(evaluation),
    ...coverageSection(evaluation),
    ...skippedSection(evaluation),
    ...notApplicableSection(evaluation),
    ...(belowBar.length
      ? ["", "Below the pass bar:", "", ...belowBar.map((line) => `- ${line}`)]
      : []),
    "",
  ].join("\n");
}
