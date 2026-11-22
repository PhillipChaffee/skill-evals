import type { Evaluation } from "../evaluate.js";
import { describeSubject } from "../subject.js";
import { formatScore } from "../score.js";
import { verdictText } from "../delta-format.js";
import {
  discriminationRows,
  discriminationRule,
  flakeRows,
  flakeText,
  PASS_AT,
  footnote,
  verdictCell,
} from "./delta.js";
import { caseRows } from "./rows.js";
import { escapeXml } from "./xml.js";

const STYLE = `body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem;color:#1b1b1b;background:#fff}
table{border-collapse:collapse;margin:1rem 0;width:100%}
th,td{border:1px solid #bbb;padding:.3rem .6rem;text-align:left;vertical-align:top}
th{background:#eee}
.below,.invalid{color:#a40000}
.not-run,.not-applicable{color:#6b5a00}
@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#161616}th{background:#2a2a2a}td,th{border-color:#555}.below,.invalid{color:#ff8080}.not-run,.not-applicable{color:#e6c84d}}`;

const e = escapeXml;

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
  const { comparison } = evaluation;
  const note = footnote(evaluation);
  if (comparison === null || note === null) return "";
  const verdicts = comparison.harnesses.flatMap(({ harness, cases, suite }) => [
    ...cases.map((one) => ({
      cells: [harness, one.id, verdictCell(one)],
    })),
    { cells: [harness, "suite", verdictText(suite)] },
  ]);
  const found = discriminationRows(evaluation);
  const discrimination =
    found.length === 0
      ? ""
      : `<h2>Discrimination</h2><p>${e(discriminationRule())}</p>${table(
          ["Harness", "Case", "None", "Subject", "Discrimination"],
          found.map((row) => ({
            cells: [
              row.harness,
              row.caseId,
              formatScore(row.none),
              formatScore(row.subject),
              row.label,
            ],
          })),
        )}`;
  return `<h2>Verdicts</h2>
${table(["Harness", "Case", "Verdict"], verdicts)}
${discrimination}
<p>${e(note)}</p>
`;
}

/**
 * Writes the table of how much each check flipped between reps.
 * @param evaluation - What `evaluate` returned.
 * @returns The HTML of the section.
 */
const flakeHtml = (evaluation: Evaluation): string =>
  `<h2>Flake</h2>
<p>A rep passes a check at a score of ${String(PASS_AT)} or more. Flake is the share of valid reps that disagree with the majority outcome; an even split is 50%.</p>
${table(
  ["Harness", "Subject", "Case", "Check", "Flake"],
  flakeRows(evaluation).map((row) => ({
    cells: [
      row.harness,
      row.subject,
      row.caseId,
      row.check,
      flakeText(row.rate),
    ],
  })),
)}
`;

/**
 * Renders an evaluation as one self-contained HTML page: inline style, tables only, no script and no reference to
 * anything else. Every value is escaped.
 * @param evaluation - What `evaluate` returned.
 * @returns The text of `report.html`.
 */
export function renderHtml(evaluation: Evaluation): string {
  const runs = (valid: number, planned: number): string =>
    `${String(valid)} of ${String(planned)} runs`;
  const suites = evaluation.suites.flatMap((suite) =>
    evaluation.subjects.map(({ label }) => ({
      cells: [
        suite.harness,
        label,
        formatScore(suite.suite[label] ?? null),
        `${String(suite.applicable)} of ${String(suite.total)} cases`,
        runs(suite.runs[label]?.valid ?? 0, suite.runs[label]?.planned ?? 0),
      ],
    })),
  );
  const cases = caseRows(evaluation).map((row) => ({
    status: row.status,
    cells: [
      row.harness,
      row.subject,
      row.caseId,
      formatScore(row.score),
      runs(row.validRuns, row.plannedRuns),
      row.status,
      row.reason,
    ],
  }));
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
<h2>Suite scores</h2>
${table(["Harness", "Subject", "Score", "Cases", "Runs"], suites)}
<h2>Cases</h2>
${table(["Harness", "Subject", "Case", "Score", "Runs", "Status", "Reason"], cases)}
${comparisonHtml(evaluation)}${flakeHtml(evaluation)}${bars === "" ? "" : `<h2>Below the pass bar</h2><ul>${bars}</ul>`}
</body></html>
`;
}
