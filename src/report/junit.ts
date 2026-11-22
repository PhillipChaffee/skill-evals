import type { Evaluation } from "../evaluate.js";
import { formatScore, missesBar } from "../score.js";
import { sourceChangedMessage } from "../subject.js";
import type { CaseRow } from "./rows.js";
import { caseRows } from "./rows.js";
import { escapeXml } from "./xml.js";

const MS_PER_SECOND = 1000;
const TIME_DECIMALS = 3;

/**
 * Seconds of the runs of one case, one harness and one subject, which a JUnit reader shows as the test's time.
 * @param evaluation - What `evaluate` returned.
 * @param row - The case.
 * @returns The seconds, summed over the runs of the case that finished.
 */
function secondsOf(evaluation: Evaluation, row: CaseRow): string {
  const ms = evaluation.records
    .filter(
      (record) =>
        record.harness === row.harness &&
        record.subject === row.subject &&
        record.caseId === row.caseId,
    )
    .reduce((sum, record) => sum + record.durationMs, 0);
  return (ms / MS_PER_SECOND).toFixed(TIME_DECIMALS);
}

/** One testcase of the report, before it is written. */
interface Test {
  name: string;
  time: string;
  /** What went wrong, and how the reader should file it; none for a pass. */
  problem?: { kind: "failure" | "error" | "skipped"; message: string };
  out?: string;
  err?: string;
}

const KINDS: Record<CaseRow["status"], "failure" | "error" | "skipped" | null> =
  {
    below: "failure",
    invalid: "error",
    "not-applicable": "skipped",
    "not-run": "skipped",
    pass: null,
  };

/**
 * Makes the testcase of one case. A case whose invalid runs are within `--max-invalid`, and that has a valid run, is
 * scored by its score, and its invalid runs are named in `system-err`; the others are filed by their status.
 * @param evaluation - What `evaluate` returned.
 * @param row - The case.
 * @returns The testcase.
 */
function testOf(evaluation: Evaluation, row: CaseRow): Test {
  const tolerated = row.status === "invalid" && row.tolerated;
  const used = tolerated ? row.byScore : row;
  const kind = KINDS[used.status];
  const counted = `${String(row.validRuns)} of ${String(row.plannedRuns)} runs`;
  return {
    name: row.caseId,
    time: secondsOf(evaluation, row),
    ...(kind === null
      ? {}
      : {
          problem: {
            kind,
            message:
              used.status === "below"
                ? `${used.reason} (${counted})`
                : used.reason,
          },
        }),
    ...(row.score === null
      ? {}
      : { out: `score ${formatScore(row.score)} (${counted})` }),
    ...(tolerated
      ? { err: `invalid runs, within --max-invalid: ${row.reason}` }
      : {}),
  };
}

/**
 * Makes the testcases that stand for the suite as a whole: its score against `--min-score`, and the subject staying as
 * it was.
 * @param evaluation - What `evaluate` returned.
 * @param harness - The harness of the testsuite.
 * @param label - The subject of the testsuite.
 * @returns A "suite score" testcase, a failure when the suite is under `--min-score`, and a "subject unchanged"
 *   testcase, an error, when the subject directory changed.
 */
function suiteTests(
  evaluation: Evaluation,
  harness: string,
  label: string,
): Test[] {
  const suite = evaluation.suites.find((one) => one.harness === harness);
  const score = suite?.suite[label] ?? null;
  const counts = suite?.runs[label] ?? { valid: 0, planned: 0 };
  const counted = `${String(counts.valid)} of ${String(counts.planned)} runs`;
  const bar = evaluation.minScore ?? undefined;
  const under = label === evaluation.barSubject && missesBar(score, bar);
  const tests: Test[] = [];
  if (suite !== undefined && suite.applicable > 0) {
    tests.push({
      name: "suite score",
      time: (0).toFixed(TIME_DECIMALS),
      out: `score ${formatScore(score)} (${counted})`,
      ...(under
        ? {
            problem: {
              kind: "failure",
              message: `suite score ${formatScore(score)} (${counted}) does not reach --min-score ${formatScore(bar ?? null)}`,
            },
          }
        : {}),
    });
  }
  if (evaluation.sourceChanged.length > 0) {
    tests.push({
      name: "subject unchanged",
      time: (0).toFixed(TIME_DECIMALS),
      problem: {
        kind: "error",
        message: sourceChangedMessage(evaluation.sourceChanged),
      },
    });
  }
  return tests;
}

/**
 * Writes one testcase.
 * @param test - The testcase.
 * @param classname - The testsuite's name.
 * @returns The `testcase` element.
 */
function writeTest(test: Test, classname: string): string {
  const { problem } = test;
  const inner = [
    problem === undefined
      ? ""
      : `<${problem.kind} message="${escapeXml(problem.message)}"/>`,
    test.out === undefined
      ? ""
      : `<system-out>${escapeXml(test.out)}</system-out>`,
    test.err === undefined
      ? ""
      : `<system-err>${escapeXml(test.err)}</system-err>`,
  ].join("");
  return `    <testcase classname="${escapeXml(classname)}" name="${escapeXml(test.name)}" time="${test.time}">${inner}</testcase>`;
}

/**
 * Counts the testcases of each kind.
 * @param tests - The testcases.
 * @returns The attributes that a `testsuite` or `testsuites` carries.
 */
const countsOf = (tests: Test[]): string => {
  const count = (kind: "failure" | "error" | "skipped"): string =>
    String(tests.filter((test) => test.problem?.kind === kind).length);
  return `tests="${String(tests.length)}" failures="${count("failure")}" errors="${count("error")}" skipped="${count("skipped")}"`;
};

/**
 * Renders an evaluation as a JUnit XML report, the format that CI systems read.
 * @param evaluation - What `evaluate` returned.
 * @returns One `testsuite` for each harness and subject, and one `testcase` for each case. A case below its bar is a
 *   `failure`, a case with no valid run, or with invalid runs above `--max-invalid`, an `error`, and a case that is not
 *   applicable, or did not run, `skipped`. A case whose invalid runs are within the budget is scored by its score and
 *   names them in `system-err`. Each testsuite also has a "suite score" testcase, a `failure` when the suite is under
 *   `--min-score`, and, when the subject directory changed, a "subject unchanged" `error`.
 */
export function renderJunit(evaluation: Evaluation): string {
  const rows = caseRows(evaluation);
  const keys = [
    ...new Set(rows.map((row) => `${row.harness}\u0000${row.subject}`)),
  ];
  const all: Test[] = [];
  const suites = keys.map((key) => {
    const mine = rows.filter(
      (row) => `${row.harness}\u0000${row.subject}` === key,
    );
    const [first] = mine;
    const harness = first?.harness ?? "";
    const label = first?.subject ?? "";
    const tests = [
      ...mine.map((row) => testOf(evaluation, row)),
      ...suiteTests(evaluation, harness, label),
    ];
    all.push(...tests);
    const name = `${harness} ${label}`;
    return `  <testsuite name="${escapeXml(name)}" ${countsOf(tests)}>\n${tests.map((test) => writeTest(test, name)).join("\n")}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="skill-evals" ${countsOf(all)}>\n${suites.join("\n")}\n</testsuites>\n`;
}
