import type { Case } from "../cases.js";
import type { HarnessDelta } from "../comparison.js";
import { describeCheck, isJudged } from "../checks/index.js";
import type { Evaluation } from "../evaluate.js";
import { METRICS, checkRate, median, scorerLine, versus } from "./metrics.js";
import { runsText } from "./counts.js";
import type { DiscriminationRow } from "./delta.js";
import {
  discriminationRows,
  discriminationRule,
  flakeRate,
  flakeText,
  footnote,
  suiteVerdictCell,
  verdictCell,
} from "./delta.js";
import { noteSections } from "./notes.js";
import type { RunRecord } from "../run.js";
import { invalidReason } from "../run.js";
import type { SuiteScore } from "../score.js";
import { formatScore } from "../score.js";
import type { Coverage } from "../select.js";
import { coverageOf } from "../select.js";
import { describeSubject } from "../subject.js";

const SHOWN_REASON_LENGTH = 300;

const cell = (text: string): string => text.replaceAll("|", "\\|");

/** What one harness's section of the report is built from. */
interface Section {
  suite: SuiteScore;
  cases: Case[];
  /** The runs of this harness. */
  records: RunRecord[];
  labels: string[];
  /** The comparison of this harness; absent with one subject. */
  delta?: HarnessDelta | undefined;
  /** The discrimination of this harness's cases; empty unless a subject is "none". */
  discrimination: DiscriminationRow[];
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
  const scored = suite.cases.find((one) => one.id === caseDef.id);
  const checks = caseDef.checks.map((check, index) => {
    const rates = valid.map(
      ({ label, runs }) =>
        tag(label) +
        checkRate(check, index, {
          valid: runs,
          planned: scored?.runs[label]?.planned ?? 0,
        }),
    );
    return `\`${describeCheck(check)}\` ${rates.join(", ")}`;
  });
  const flakes = caseDef.checks.map((_check, index) =>
    valid
      .map(
        ({ label, runs }) =>
          tag(label) +
          flakeText(flakeRate(runs, index), {
            valid: runs.length,
            planned: scored?.runs[label]?.planned ?? 0,
          }),
      )
      .join(", "),
  );
  const cells = [
    caseDef.id,
    `${versus(Object.values(scored?.scores ?? {}), formatScore)} ${runsText(scored?.runs ?? {}, labels)}`,
    ...(section.delta
      ? [verdictCell(section.delta.cases.find((one) => one.id === caseDef.id))]
      : []),
    checks.join("<br>"),
    flakes.join("<br>"),
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

/**
 * Words a column title for one subject, or for a comparison.
 * @param title - The column's name.
 * @param labels - The subject labels.
 * @returns The title; "Score, A / B (B - A)" for a comparison.
 */
const heading = (title: string, labels: string[]): string =>
  labels.length > 1 ? `${title}, A / B (B - A)` : title;

/**
 * Lays out the cases of one harness as a table.
 * @param those - The cases, one for each row.
 * @param section - The scores and runs of the harness.
 * @returns The header, the rule, and a row for each case. A comparison adds a verdict column after the score; every
 *   table has a flake column after the checks.
 */
function caseTable(those: Case[], section: Section): string[] {
  const { labels, delta } = section;
  const columns = [
    "Case",
    heading("Score", labels),
    ...(delta ? ["Verdict"] : []),
    "Checks",
    "Flake",
    ...METRICS.map((metric) => heading(metric.title, labels)),
  ];
  return [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...those.map((caseDef) => caseRow(caseDef, section)),
  ];
}

/**
 * Words the delta of the suite and the discrimination of its cases.
 * @param section - The scores and runs of the harness.
 * @returns The suite verdict line, and the discrimination table when a subject is "none"; none for one subject.
 */
function deltaLines(section: Section): string[] {
  const { delta, discrimination } = section;
  if (!delta) return [];
  return [
    `Suite delta: ${suiteVerdictCell(delta.suite)} over ${String(delta.suite.cases)} ${delta.suite.cases === 1 ? "case" : "cases"}`,
    ...(discrimination.length === 0
      ? []
      : [
          "",
          "### Discrimination",
          "",
          discriminationRule(),
          "",
          "| Case | None | Subject | Discrimination |",
          "| --- | --- | --- | --- |",
          ...discrimination.map(
            (row) =>
              `| ${cell(row.caseId)} | ${formatScore(row.none)} | ${formatScore(row.subject)} | ${row.label} |`,
          ),
        ]),
  ];
}

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
  const invalid = records.flatMap((record) => {
    const reason = invalidReason(record);
    if (reason === null) return [];
    const shown = reason.replace(/\s+/g, " ").slice(0, SHOWN_REASON_LENGTH);
    return [
      `- ${record.subject.toUpperCase()} \`${record.caseId}\` rep ${String(record.rep)}: ${shown}`,
    ];
  });
  const tableOf = (those: Case[]): string[] => caseTable(those, section);
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
    `Suite score: ${versus(Object.values(suite.suite), formatScore)} (${String(suite.applicable)} of ${String(suite.total)} cases, ${runsText(suite.runs, labels).slice(1, -1)})`,
    ...deltaLines(section),
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
 * Shows the score over the cases that apply to every harness, the only score that compares harnesses.
 * @param evaluation - What `evaluate` returned.
 * @returns The section, or nothing for a single harness.
 */
function commonSection(evaluation: Evaluation): string[] {
  const { commonSet } = evaluation;
  if (!commonSet) return [];
  const labels = evaluation.subjects.map((subject) => subject.label);
  const skipped = new Set(evaluation.skippedChecks.map((one) => one.caseId));
  const withSkips = commonSet.cases.filter((id) => skipped.has(id)).length;
  const skips =
    withSkips === 0
      ? ""
      : `, ${String(withSkips)} ${withSkips === 1 ? "case" : "cases"} with skipped checks`;
  return [
    "",
    "## Common set",
    "",
    `Common set (${String(commonSet.cases.length)} cases: ${commonSet.cases.join(", ") || "none"}${skips}). Only these scores compare harnesses.`,
    "",
    ...Object.entries(commonSet.suite).map(
      ([harness, scores]) =>
        `- ${harness}: ${versus(Object.values(scores), formatScore)} ${runsText(commonSet.runs[harness] ?? {}, labels)}`,
    ),
  ];
}

/**
 * Words the method behind the verdicts under the tables.
 * @param evaluation - What `evaluate` returned.
 * @returns The footnote after a blank line; none for one subject.
 */
function footnoteLines(evaluation: Evaluation): string[] {
  const note = footnote(evaluation);
  return note === null ? [] : ["", `> ${note}`];
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
  const discrimination = discriminationRows(evaluation);
  const sections = evaluation.suites.map((suite) =>
    harnessSection({
      suite,
      delta: evaluation.comparison?.harnesses.find(
        (one) => one.harness === suite.harness,
      ),
      discrimination: discrimination.filter(
        (row) => row.harness === suite.harness,
      ),
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
    ...footnoteLines(evaluation),
    ...noteSections(evaluation),
    ...(belowBar.length
      ? ["", "Below the pass bar:", "", ...belowBar.map((line) => `- ${line}`)]
      : []),
    "",
  ].join("\n");
}
