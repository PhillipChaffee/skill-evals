import type { Evaluation } from "../evaluate.js";
import { describeSubject } from "../subject.js";
import { formatScore } from "../score.js";
import {
  discriminationRows,
  discriminationRule,
  flakeRows,
  flakeText,
  PASS_AT,
  footnote,
  suiteVerdictCell,
  verdictCell,
} from "./delta.js";
import { caseRows } from "./rows.js";
import { triggerTable } from "./trigger.js";
import { escapeXml } from "./xml.js";

const STYLE = `body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem;color:#1b1b1b;background:#fff}
table{border-collapse:collapse;margin:1rem 0;width:100%}
th,td{border:1px solid #bbb;padding:.3rem .6rem;text-align:left;vertical-align:top}
th{background:#eee}
.below,.invalid{color:#a40000}
.not-run,.not-applicable{color:#6b5a00}
@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#161616}th{background:#2a2a2a}td,th{border-color:#555}.below,.invalid{color:#ff8080}.not-run,.not-applicable{color:#e6c84d}}`;

const e = escapeXml;

// What a suite cell shows when a harness has no comparison entry.
const NO_SUITE = {
  delta: null,
  low: null,
  high: null,
  verdict: null,
  noise: null,
  cases: 0,
  fewest: null,
};

/**
 * Writes one table.
 * @param head - The column titles.
 * @param rows - The rows; each cell is text and is escaped, and a cell may name a class for its row's status.
 * @returns The `table` element.
 */
function table(
  head: string[],
  rows: { cells: string[]; status?: string }[],
): string {
  const header = head.map((title) => `<th>${e(title)}</th>`).join("");
  const body = rows.map(
    ({ cells, status }) =>
      `<tr${status === undefined ? "" : ` class="${e(status)}"`}>${cells.map((cell) => `<td>${e(cell)}</td>`).join("")}</tr>`,
  );
  return `<table><thead><tr>${header}</tr></thead><tbody>${body.join("")}</tbody></table>`;
}

/**
 * Writes the sections that a comparison adds: the verdicts, the discrimination, and the footnote.
 * @param evaluation - What `evaluate` returned.
 * @returns The HTML of the sections; nothing for one subject.
 */
function comparisonHtml(evaluation: Evaluation): string {
  const note = footnote(evaluation);
  if (note === null) return "";
  const found = discriminationRows(evaluation);
  // Two subjects have one comparison, so the table needs no column to say which subject a row is for.
  const many = evaluation.comparisons.length > 1;
  const discrimination =
    found.length === 0
      ? ""
      : `<h2>Discrimination</h2><p>${e(discriminationRule())}</p>${table(
          [
            ...[
              "Harness",
              "Case",
              ...(many ? ["Subject arm", "None arm"] : []),
            ],
            ...["None", "Subject", "Discrimination"],
          ],
          found.map((row) => ({
            cells: [
              row.harness,
              row.caseId,
              ...(many ? [row.arm, row.noneArm] : []),
              formatScore(row.none),
              formatScore(row.subject),
              row.label,
            ],
          })),
        )}`;
  return `${discrimination}
<p>${e(note)}</p>
`;
}

/**
 * Words the flake of each check of a case, for one cell.
 * @param rows - Every flake row of the evaluation.
 * @param row - The case row the cell is for.
 * @param row.harness - Which harness ran the case.
 * @param row.subject - The label of the subject on the row.
 * @param row.caseId - Which case the row sums up.
 * @returns The rates of the case's checks, in order: "0%, 33%".
 */
const flakeCell = (
  rows: ReturnType<typeof flakeRows>,
  row: { harness: string; subject: string; caseId: string },
): string =>
  rows
    .filter(
      (one) =>
        one.harness === row.harness &&
        one.subject === row.subject &&
        one.caseId === row.caseId,
    )
    .map((one) => flakeText(one.rate, one.counts))
    .join(", ");

/**
 * Writes the suite table and the case table, which a comparison gives a verdict column, and every table a flake column.
 * @param evaluation - What `evaluate` returned.
 * @returns The HTML of both tables and the note on flake.
 */
function tablesHtml(evaluation: Evaluation): string {
  const runs = (valid: number, planned: number): string =>
    `${String(valid)} of ${String(planned)} runs`;
  const { comparisons } = evaluation;
  const verdict = (cells: string[]): string[] =>
    comparisons.length === 0 ? [] : cells;
  // The comparison that a subject's row shows: its own, or for two subjects the one comparison on both rows.
  const ownOf = (label: string) =>
    comparisons.find((one) => one.subject === label) ??
    (comparisons.length === 1 ? comparisons[0] : undefined);
  const suites = evaluation.suites.flatMap((suite) =>
    evaluation.subjects.map(({ label }) => ({
      cells: [
        suite.harness,
        label,
        formatScore(suite.suite[label] ?? null),
        ...verdict([
          suiteVerdictCell(
            ownOf(label)?.harnesses.find((one) => one.harness === suite.harness)
              ?.suite ?? NO_SUITE,
          ),
        ]),
        `${String(suite.applicable)} of ${String(suite.total)} cases`,
        runs(suite.runs[label]?.valid ?? 0, suite.runs[label]?.planned ?? 0),
      ],
    })),
  );
  const flakes = flakeRows(evaluation);
  const cases = caseRows(evaluation).map((row) => ({
    status: row.status,
    cells: [
      row.harness,
      row.subject,
      row.caseId,
      formatScore(row.score),
      ...verdict([
        verdictCell(
          ownOf(row.subject)
            ?.harnesses.find((one) => one.harness === row.harness)
            ?.cases.find((one) => one.id === row.caseId),
        ),
      ]),
      runs(row.validRuns, row.plannedRuns),
      flakeCell(flakes, row),
      row.status,
      row.reason,
    ],
  }));
  return `<h2>Suite scores</h2>
${table(["Harness", "Subject", "Score", ...verdict(["Verdict"]), "Cases", "Runs"], suites)}
<h2>Cases</h2>
${table(["Harness", "Subject", "Case", "Score", ...verdict(["Verdict"]), "Runs", "Flake", "Status", "Reason"], cases)}
<p>A rep passes a check at a score of ${String(PASS_AT)} or more. Flake is the share of valid reps that disagree with the majority outcome, for each check in order; an even split is 50%.</p>`;
}

/**
 * Writes the trigger table: for each target skill, recall on the development and the held-out prompts, the gap, and the
 * false-trigger rate.
 * @param evaluation - What `evaluate` returned.
 * @returns The HTML of the section; nothing when no case names a target.
 */
function triggerHtml(evaluation: Evaluation): string {
  const found = triggerTable(evaluation);
  if (found === null) return "";
  return `<h2>Trigger recall by target skill</h2>
${table(
  found.head.map((title) => title.charAt(0).toUpperCase() + title.slice(1)),
  found.body.map((cells) => ({ cells })),
)}
`;
}

/**
 * Renders an evaluation as one self-contained HTML page: inline style, tables only, no script and no reference to
 * anything else. Every value is escaped.
 * @param evaluation - What `evaluate` returned.
 * @returns The text of `report.html`.
 */
export function renderHtml(evaluation: Evaluation): string {
  const subjects = evaluation.subjects
    .map(
      (subject) =>
        `<li>${e(subject.label)}: ${e(describeSubject(subject))}</li>`,
    )
    .join("");
  const bars = evaluation.belowBar
    .map((line) => `<li class="below">${e(line)}</li>`)
    .join("");
  const stopped =
    evaluation.partial === null
      ? ""
      : `<p class="not-run">The command stopped early: ${e(evaluation.partial.reason)}. Scores cover finished runs only.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skill scores</title><style>${STYLE}</style></head>
<body><h1>Skill scores</h1>
<ul>${subjects}</ul>
<p>Exit code ${String(evaluation.exit)}. Output: ${e(evaluation.outDir)}</p>${stopped}
${tablesHtml(evaluation)}
${triggerHtml(evaluation)}${comparisonHtml(evaluation)}${bars === "" ? "" : `<h2>Below the pass bar</h2><ul>${bars}</ul>`}
</body></html>
`;
}
