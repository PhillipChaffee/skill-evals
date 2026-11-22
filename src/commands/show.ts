import fs from "node:fs";
import path from "node:path";
import { describeCheck } from "../checks/index.js";
import { EXIT } from "../exit-codes.js";
import type { TranscriptEvent } from "../harnesses/shared.js";
import type { Project } from "../project.js";
import { readResultsFile } from "../results-file.js";
import { within } from "../rescore.js";
import type { RunRecord } from "../run.js";
import { resultsByCall } from "../transcript.js";
import { UsageError, messageOf } from "../scope.js";
import type { Options } from "../usage.js";

/** The most characters of one event's input, output or text that `show` prints. */
export const SHOW_CUT = 200;

const DEFAULT_REP = 1;
const SCORE_DIGITS = 2;

/**
 * Writes the payload of one event on one line, cut where it is long.
 * @param event - The transcript event.
 * @returns What the event carried, as JSON on one line, such as `input {"command":"ls"}`; a cut payload ends with
 *   the words `[cut at 200 of <n> characters]`. A lifecycle or hook event that carries no text is empty.
 */
function payload(event: TranscriptEvent): string {
  const [label, value] =
    event.input !== undefined
      ? ["input", event.input]
      : event.output !== undefined
        ? ["output", event.output]
        : ["text", event.text];
  if (value === undefined) return "";
  const written = JSON.stringify(value);
  const shown =
    written.length > SHOW_CUT
      ? `${written.slice(0, SHOW_CUT)} [cut at ${String(SHOW_CUT)} of ${String(written.length)} characters]`
      : written;
  return `${label} ${shown}`;
}

/**
 * Writes one transcript event as a line.
 * @param event - The transcript event to write.
 * @param call - The number that the checks give the call, as in `#0`: the call's own for a call, the call it answers
 *   for a result, and absent for any other event.
 * @returns `<index>: <agent> <kind or type> <name> [call #<n>] <payload>`. The first number is the event's place in
 *   the transcript; `call #<n>` is the number that a check's reason quotes.
 */
const eventLine = (event: TranscriptEvent, call?: number): string =>
  [
    `${String(event.index)}:`,
    event.agent.id,
    event.kind ?? event.type,
    event.name ?? "-",
    ...(call === undefined
      ? []
      : [
          `${event.type === "tool_call" ? "call" : "result of call"} #${String(call)}`,
        ]),
    payload(event),
  ]
    .join(" ")
    .trimEnd();

/**
 * Numbers the events that belong to a tool call the way a check's reason does.
 * @param events - The run's events.
 * @returns For the index of an event, the position of its call among the run's calls; a call and the result that
 *   answers it have the same number.
 */
function callNumbers(events: TranscriptEvent[]): Map<number, number> {
  const numbers = new Map<number, number>();
  const calls = events.filter(({ type }) => type === "tool_call");
  calls.forEach((one, position) => numbers.set(one.index, position));
  for (const [position, answer] of resultsByCall(events)) {
    numbers.set(answer.index, position);
  }
  return numbers;
}

/**
 * Reads the transcript file of a run, and says when it cannot.
 * @param record - The stored run.
 * @param dir - The output directory.
 * @returns The events, or the line that says why there are none.
 */
function transcriptLines(record: RunRecord, dir: string): string[] {
  const named = record.transcriptFile;
  if (!named) return ["transcript: the run wrote none"];
  try {
    const file = within(dir, named);
    const events = JSON.parse(
      fs.readFileSync(file, "utf8"),
    ) as TranscriptEvent[];
    const numbers = callNumbers(events);
    return [
      `transcript: ${named}, ${String(events.length)} events; each input, output and text is cut at ${String(SHOW_CUT)} characters`,
      ...events.map((one) => eventLine(one, numbers.get(one.index))),
    ];
  } catch (error) {
    return [`transcript: ${named} cannot be read (${messageOf(error)})`];
  }
}

/**
 * Writes the checks of a run, each with its score and its reason.
 * @param record - The stored run.
 * @returns One line for each check, then its reason indented, which quotes the calls it is about.
 */
function checkLines(record: RunRecord): string[] {
  return [
    `checks${record.ok ? "" : ` (run invalid: ${String(record.error)})`}`,
    ...record.checks.flatMap((check, index) => [
      `${String(index + 1)}. ${describeCheck(check)}: ${check.score === null ? "no score" : check.score.toFixed(SCORE_DIGITS)}`,
      ...(check.reason === undefined
        ? []
        : check.reason.split("\n").map((row) => `   ${row}`)),
    ]),
  ];
}

/**
 * Picks the runs that `show` prints, and refuses what does not exist.
 * @param records - Every record of the results.
 * @param wanted - The case, and the subject label and rep when given.
 * @param wanted.caseId - The id of the case whose run is printed.
 * @param wanted.subject - The subject's label; absent for the first label of the results.
 * @param wanted.rep - The number of the run among the case's reps, counted from 1.
 * @param labels - The subject labels of the results, in order.
 * @returns The records of that case, subject and rep, one for each harness.
 * @throws {UsageError} For a case, subject or rep that the results do not hold; the message lists what they hold.
 */
function chosen(
  records: RunRecord[],
  wanted: { caseId: string; subject: string | undefined; rep: number },
  labels: string[],
): RunRecord[] {
  const ofCase = records.filter(({ caseId }) => caseId === wanted.caseId);
  if (ofCase.length === 0) {
    const ids = [...new Set(records.map(({ caseId }) => caseId))].sort();
    throw new UsageError(
      `no case "${wanted.caseId}" in the results; cases: ${ids.join(", ") || "none"}`,
    );
  }
  const subject = wanted.subject ?? labels[0];
  const ofSubject = ofCase.filter((record) => record.subject === subject);
  if (ofSubject.length === 0) {
    const held = [...new Set(ofCase.map((record) => record.subject))];
    throw new UsageError(
      `no subject "${String(subject)}" for ${wanted.caseId}; subjects: ${held.join(", ")}`,
    );
  }
  const found = ofSubject.filter(({ rep }) => rep === wanted.rep);
  if (found.length === 0) {
    const reps = [...new Set(ofSubject.map(({ rep }) => rep))].sort(
      (x, y) => x - y,
    );
    throw new UsageError(
      `no rep ${String(wanted.rep)} of ${wanted.caseId} for ${String(subject)}; reps: ${reps.join(", ")}`,
    );
  }
  return found;
}

/**
 * The `show` command: prints what one run did, one line for each transcript event, and then what each check scored and
 * why. It only reads: it takes no lock, so it may run beside a command that is still writing.
 * @param options - The command line's options: `subject` (a label) and `rep`.
 * @param project - Where the command runs.
 * @param args - The output directory of an earlier command, and the case id.
 * @returns The exit code, always 0; a fault throws.
 * @throws {UsageError} When the directory holds no results, or the case, subject or rep does not exist in them.
 */
export function show(
  options: Options,
  project: Project,
  args: string[],
): number {
  const { results, dir } = readResultsFile(
    path.resolve(project.cwd, String(args[0])),
  );
  const labels = results.subjects.map(({ label }) => label);
  const records = chosen(
    results.records,
    {
      caseId: String(args[1]),
      subject: options.subject,
      rep: options.rep ?? DEFAULT_REP,
    },
    labels,
  );
  console.log(
    records
      .flatMap((record) => [
        `${record.harness} ${record.caseId} ${record.subject}${String(record.rep)}`,
        ...transcriptLines(record, dir),
        ...checkLines(record),
        "",
      ])
      .join("\n"),
  );
  return EXIT.ok;
}
