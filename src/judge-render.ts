import fs from "node:fs";
import type { Sees } from "./checks/judge-fields.js";
import { find } from "./checks/tree.js";
import type { TranscriptEvent } from "./harnesses/shared.js";
import { forRecord } from "./transcript.js";

/** The default size of a transcript rendering, in characters. */
const TRANSCRIPT_CHARS = 60_000;
/** The size each tool output is cut to when a rendering does not fit. */
const OUTPUT_CHARS = 400;
/** The size each file is cut to. */
const FILE_CHARS = 20_000;
/** How much of a file is looked at for a NUL byte. */
const SNIFF_BYTES = 8192;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|avif|heic)$/i;
const NO_EVENTS = "(no events)";

/** What a judge or decision model is shown besides the task. */
export interface Seen {
  /** Whether the final answer is shown. */
  final: boolean;
  transcript?: string;
  files?: string;
}

/**
 * Keeps an event on one line.
 * @param text - Any text.
 * @returns The text with each line break written as `\n`.
 */
const oneLine = (text: string): string => text.replace(/\r?\n/g, "\\n");

/**
 * Writes what an event holds.
 * @param event - One event.
 * @param cap - The most characters of a tool output; undefined for no cut beyond the record's.
 * @returns The text after the colon of the event's line.
 */
function bodyOf(event: TranscriptEvent, cap?: number): string {
  if (event.type === "tool_call") {
    const input = JSON.stringify(event.input ?? {});
    return `${event.name ?? event.kind ?? "tool"} ${input}`;
  }
  const text = event.output ?? event.text ?? event.name ?? "";
  const shown =
    event.type === "tool_result" && cap !== undefined && text.length > cap
      ? `${text.slice(0, cap)}…`
      : text;
  return oneLine(`${event.isError ? "error: " : ""}${shown}`);
}

/**
 * Writes the line of one event.
 * @param event - The event to write.
 * @param cap - The most characters of a tool output, as `bodyOf` takes it.
 * @returns `[#i t<turn> <agent type>] <role> <type>: …`.
 */
const lineOf = (event: TranscriptEvent, cap?: number): string =>
  `[#${String(event.index)} t${event.turn === null ? "-" : String(event.turn)} ${event.agent.type}] ${event.role} ${event.type}: ${bodyOf(event, cap)}`;

const isOutput = (event: TranscriptEvent): boolean =>
  event.type === "tool_result" && event.output !== undefined;

/**
 * Writes a run's events for a model to read.
 * @param events - The run's events.
 * @param maxChars - The most characters of the result. Default: 60,000.
 * @returns One line per event. When the whole does not fit, each tool output is cut to 400 characters, and then the
 *   oldest tool outputs are dropped, and then the oldest events; a first line says what was left out. A rendering
 *   that fits has no such line.
 */
export function renderTranscript(
  events: TranscriptEvent[],
  maxChars = TRANSCRIPT_CHARS,
): string {
  const recorded = forRecord(events);
  const fits = (lines: string[], note: string): string | null => {
    const text = [...(note ? [note] : []), ...lines].join("\n");
    return text.length <= maxChars ? text : null;
  };
  const whole = recorded.map((event) => lineOf(event));
  const outputs = recorded.filter(isOutput).length;
  const cutAll = recorded.map((event) => lineOf(event, OUTPUT_CHARS));
  const cutNote = `[… ${String(outputs)} tool outputs cut to ${String(OUTPUT_CHARS)} characters …]`;
  const rendered =
    fits(whole, "") ??
    (outputs > 0 ? fits(cutAll, cutNote) : null) ??
    dropped(recorded, cutAll, maxChars);
  return rendered === "" ? NO_EVENTS : rendered;
}

/**
 * Drops the oldest tool outputs, and then the oldest events, until the rendering fits.
 * @param events - The events whose outputs may go.
 * @param lines - Their lines, each output cut.
 * @param maxChars - The most characters the rendering may have.
 * @returns The rendering, with a first line that counts what was left out; cut to the limit as a last resort.
 */
function dropped(
  events: TranscriptEvent[],
  lines: string[],
  maxChars: number,
): string {
  const kept = events.map((_, at) => at);
  let omitted = 0;
  let earlier = 0;
  const text = (): string => {
    const note = [
      ...(omitted > 0 ? [`[… ${String(omitted)} tool outputs omitted …]`] : []),
      ...(earlier > 0
        ? [`[… ${String(earlier)} earlier events omitted …]`]
        : []),
    ];
    return [...note, ...kept.map((at) => lines[at])].join("\n");
  };
  for (const at of kept.filter((one) =>
    isOutput(events[one] as TranscriptEvent),
  )) {
    if (text().length <= maxChars) break;
    kept.splice(kept.indexOf(at), 1);
    omitted += 1;
  }
  while (text().length > maxChars && kept.length > 1) {
    kept.shift();
    earlier += 1;
  }
  return text().slice(0, maxChars);
}

/**
 * Reads one file for a model.
 * @param relative - The file's relative path.
 * @param real - The file's real path.
 * @returns The `<file>` block: the text cut to 20,000 characters, or the name and why it is not shown.
 */
function fileBlock(relative: string, real: string): string {
  const named = (why: string): string =>
    `<file path="${relative}">not shown (${why})</file>`;
  if (IMAGE.test(relative)) return named("image");
  const bytes = fs.readFileSync(real);
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return named("binary");
  const text = bytes.toString("utf8");
  const body =
    text.length > FILE_CHARS
      ? `${text.slice(0, FILE_CHARS)}\n[… cut at ${String(FILE_CHARS)} characters …]`
      : text;
  return `<file path="${relative}">\n${body}\n</file>`;
}

/**
 * Reads the files a check names.
 * @param globs - Paths or globs, relative to the workspace, by the rules of the file checks: a link that leaves the
 *   workspace is not read, and a path that names a directory means the files under it.
 * @param workspace - The workspace as the run left it.
 * @returns One block for each file, once, in path order; a line that says nothing matched when no file did.
 */
export function renderFiles(globs: string[], workspace: string): string {
  const tree = {
    dir: workspace,
    seed: new Map<string, string>(),
    changed: { created: [], modified: [], deleted: [] },
    name: "workspace" as const,
    unlisted: [],
  };
  const files = new Map<string, string>();
  for (const glob of globs) {
    for (const entry of find(tree, glob, true).entries) {
      if (entry.kind === "file") files.set(entry.path, entry.real);
    }
  }
  if (files.size === 0) return `No file matches: ${globs.join(", ")}`;
  return [...files]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relative, real]) => fileBlock(relative, real))
    .join("\n");
}

/**
 * Gathers what a judge or decision check is to see.
 * @param check - The check's `sees`, `files` and `maxChars`.
 * @param check.sees - Default: the final answer only.
 * @param check.files - The globs for "files".
 * @param check.maxChars - The size of the transcript rendering.
 * @param outcome - The run's events and the workspace it left, from which the parts are read.
 * @param outcome.transcript - The events to render.
 * @param outcome.workspace - The directory the `files` globs resolve against.
 * @returns The parts to show.
 */
export function materialFor(
  check: {
    sees?: Sees[] | undefined;
    files?: string[] | undefined;
    maxChars?: number | undefined;
  },
  outcome: { transcript: TranscriptEvent[]; workspace: string },
): Seen {
  const sees = check.sees ?? ["final"];
  return {
    final: sees.includes("final"),
    ...(sees.includes("transcript")
      ? { transcript: renderTranscript(outcome.transcript, check.maxChars) }
      : {}),
    ...(sees.includes("files")
      ? { files: renderFiles(check.files ?? [], outcome.workspace) }
      : {}),
  };
}
