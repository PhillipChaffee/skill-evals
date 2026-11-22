import type { CaseDiff, CheckChange, Diff, SideCase, Totals } from "./diff.js";
import { formatScore } from "./score.js";

const MS_PER_SECOND = 1000;
const COST_DECIMALS = 4;
const SECOND_DECIMALS = 1;

const cell = (text: string): string => text.replaceAll("|", "\\|");

/**
 * Writes a signed difference.
 * @param from - The earlier value; null for none.
 * @param to - The later value; null for none.
 * @param show - Writes one value, with its unit.
 * @returns "+x" or "-x" for the change; "n/a" when either side has no value.
 */
function change(
  from: number | null,
  to: number | null,
  show: (value: number) => string,
): string {
  if (from === null || to === null) return "n/a";
  const delta = to - from;
  return `${delta < 0 ? "-" : "+"}${show(Math.abs(delta))}`;
}

const usd = (value: number): string => `$${value.toFixed(COST_DECIMALS)}`;
const seconds = (value: number): string =>
  `${(value / MS_PER_SECOND).toFixed(SECOND_DECIMALS)}s`;
const score = (value: number): string => formatScore(value);
const costText = (value: number | null): string =>
  value === null ? "n/a" : usd(value);

/**
 * Writes the score of a case on one side.
 * @param side - The case on that side; null when the side lacks it.
 * @returns The score with its run counts, as `0.80 (3/3)`; "absent" for a missing case.
 */
const scoreText = (side: SideCase | null): string =>
  side === null
    ? "absent"
    : `${formatScore(side.score)} (${String(side.runs.valid)}/${String(side.runs.planned)})`;

/**
 * Makes the table row of a case.
 * @param one - The case's differences.
 * @returns A markdown row: the scores with run counts, their change, and the change in cost and duration.
 */
function row(one: CaseDiff): string {
  const { a, b } = one;
  return `| ${cell(one.caseId)} | ${scoreText(a)} | ${scoreText(b)} | ${change(a?.score ?? null, b?.score ?? null, score)} | ${change(a?.costUsd ?? null, b?.costUsd ?? null, usd)} | ${change(a?.durationMs ?? null, b?.durationMs ?? null, seconds)} |`;
}

/**
 * Lists checks that changed.
 * @param heading - What the list is.
 * @param one - The case.
 * @param changes - The checks of the case that changed.
 * @returns The lines of the list; none when no check changed.
 */
const listOf = (
  heading: string,
  one: CaseDiff,
  changes: CheckChange[],
): string[] =>
  changes.map(
    (each) =>
      `- ${heading}: ${one.caseId}: \`${each.description}\` ${formatScore(each.from)} -> ${formatScore(each.to)}`,
  );

/**
 * Writes one side's totals.
 * @param totals - Its runs, cost and time.
 * @returns The cells for runs, cost and duration.
 */
const totalCells = (
  totals: Totals,
): { runs: string; cost: string; time: string } => ({
  runs: String(totals.runs),
  cost: costText(totals.costUsd),
  time: seconds(totals.durationMs),
});

/**
 * Renders a diff as markdown.
 * @param diff - What `diffResults` found.
 * @param names - What the two sides are called: the paths the user gave.
 * @param names.a - The earlier side.
 * @param names.b - The later side.
 * @returns The report: a warning block first when any, the totals, then each case's score change, with the checks
 *   that started or stopped passing.
 */
export function renderDiff(
  diff: Diff,
  names: { a: string; b: string },
): string {
  const warnings =
    diff.warnings.length === 0
      ? []
      : [
          "## Warnings",
          "",
          "These two results may not be a fair pair:",
          "",
          ...diff.warnings.map((text) => `- ${text}`),
          "",
        ];
  const { a, b } = diff.totals;
  const shownA = totalCells(a);
  const shownB = totalCells(b);
  const failing = diff.cases.flatMap((one) =>
    listOf("newly failing", one, one.newlyFailing),
  );
  const passing = diff.cases.flatMap((one) =>
    listOf("newly passing", one, one.newlyPassing),
  );
  return [
    "# skill-evals diff",
    "",
    `- A: ${names.a} (subject ${diff.labels.a})`,
    `- B: ${names.b} (subject ${diff.labels.b})`,
    "",
    ...warnings,
    "## Totals",
    "",
    "| | A | B | Change |",
    "| --- | --- | --- | --- |",
    ...diff.suites.map(
      (suite) =>
        `| Suite score, ${cell(suite.harness)} | ${formatScore(suite.a)} | ${formatScore(suite.b)} | ${change(suite.a, suite.b, score)} |`,
    ),
    `| Runs | ${shownA.runs} | ${shownB.runs} | ${String(b.runs - a.runs)} |`,
    `| Cost | ${shownA.cost} | ${shownB.cost} | ${change(a.costUsd, b.costUsd, usd)} |`,
    `| Duration | ${shownA.time} | ${shownB.time} | ${change(a.durationMs, b.durationMs, seconds)} |`,
    "",
    "## Cases",
    "",
    "| Case | A (valid/planned runs) | B (valid/planned runs) | Score change | Cost change | Duration change |",
    "| --- | --- | --- | --- | --- | --- |",
    ...diff.cases.map(row),
    "",
    "## Checks",
    "",
    ...(failing.length + passing.length === 0
      ? ["No check started or stopped passing."]
      : [...failing, ...passing]),
    "",
  ].join("\n");
}
