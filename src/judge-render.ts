import fs from "node:fs";
import type { Sees } from "./checks/judge-fields.js";
import { valueOf } from "./checks/defaults.js";
import { find } from "./checks/tree.js";
import { GLOB_LIMIT } from "./glob.js";
import type { TranscriptEvent } from "./harnesses/shared.js";
import type { Attachment } from "./judge-api.js";
import { forRecord } from "./transcript.js";

/** The size each tool output is cut to when a rendering does not fit. */
const OUTPUT_CHARS = 400;
/** The size each file is cut to. */
const FILE_CHARS = 20_000;
/** How much of a file is looked at for a NUL byte. */
const SNIFF_BYTES = 8192;
const UTF8_MAX_BYTES = 4;
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
 * Wraps text in a tag, the way every prompt to a model does.
 * @param tag - The tag's name.
 * @param text - What goes between the tags.
 * @returns The opening tag, the text and the closing tag, as three lines.
 */
export const tagged = (tag: string, text: string): string[] => [
  `<${tag}>`,
  text,
  `</${tag}>`,
];

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

// What a judge check that shows the transcript looks like, for the default of `maxChars`.
const TRANSCRIPT_VIEW: { type: string; sees: string[] } = {
  type: "judge",
  sees: ["transcript"],
};

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
  maxChars = valueOf(TRANSCRIPT_VIEW, "maxChars") as number,
): string {
  const recorded = forRecord(events);
  const fits = (lines: string[], note: string): string | null => {
    const text = [...(note ? [note] : []), ...lines].join("\n");
    return text.length <= maxChars ? text : null;
  };
  const whole = recorded.map((event) => lineOf(event));
  const cutOutputs = recorded.filter(
    (event) => (event.output?.length ?? 0) > OUTPUT_CHARS,
  ).length;
  const cutAll = recorded.map((event) => lineOf(event, OUTPUT_CHARS));
  const cutNote = `[… ${String(cutOutputs)} tool outputs cut to ${String(OUTPUT_CHARS)} characters …]`;
  const rendered =
    fits(whole, "") ??
    (cutOutputs > 0 ? fits(cutAll, cutNote) : null) ??
    dropped(recorded, cutAll, maxChars);
  return rendered === "" ? NO_EVENTS : rendered;
}

/**
 * Drops the oldest tool outputs, and then the oldest events, until the rendering fits.
 * @param events - The events whose outputs may go.
 * @param lines - Their lines, each output cut.
 * @param maxChars - The most characters the rendering may have.
 * @returns The rendering, with first lines that count what was left out. When one event alone is over the limit it is
 *   cut, and a last line says so.
 */
function dropped(
  events: TranscriptEvent[],
  lines: string[],
  maxChars: number,
): string {
  const alive = lines.map(() => true);
  let left = {
    chars: lines.reduce((sum, line) => sum + line.length, 0),
    count: lines.length,
  };
  let omitted = 0;
  let earlier = 0;
  const notes = (): string[] => [
    ...(omitted > 0 ? [`[… ${String(omitted)} tool outputs omitted …]`] : []),
    ...(earlier > 0 ? [`[… ${String(earlier)} earlier events omitted …]`] : []),
  ];
  // The length of the joined text, kept as a running sum so that each step costs the notes only.
  const length = (): number => {
    const own = notes();
    const lineCount = left.count + own.length;
    return (
      left.chars +
      own.reduce((sum, note) => sum + note.length, 0) +
      lineCount -
      1
    );
  };
  const drop = (at: number): void => {
    alive[at] = false;
    left = {
      chars: left.chars - (lines[at] as string).length,
      count: left.count - 1,
    };
  };
  for (const [at, event] of events.entries()) {
    if (length() <= maxChars) break;
    if (isOutput(event)) {
      drop(at);
      omitted += 1;
    }
  }
  for (const at of alive.keys()) {
    if (length() <= maxChars || left.count <= 1) break;
    if (alive[at]) {
      drop(at);
      earlier += 1;
    }
  }
  const text = [...notes(), ...lines.filter((_, at) => alive[at])].join("\n");
  if (text.length <= maxChars) return text;
  const marker = "[… last event cut …]";
  return `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`.slice(
    0,
    maxChars,
  );
}

/**
 * Reads one file for a model.
 * @param relative - The file's relative path.
 * @param real - The file's real path.
 * @param attached - The paths of the images that are sent with the prompt.
 * @returns The `<file>` block: the text cut to 20,000 characters, or the name and why it is not shown.
 */
function fileBlock(
  relative: string,
  real: string,
  attached: Set<string>,
): string {
  const named = (why: string): string =>
    `<file path="${relative}">not shown (${why})</file>`;
  if (attached.has(relative)) {
    return `<file path="${relative}">attached as an image</file>`;
  }
  if (IMAGE.test(relative)) return named("image");
  // A character is at most four bytes, so this much holds the first 20,000 characters.
  const size = fs.statSync(real).size;
  const bytes = Buffer.alloc(Math.min(size, FILE_CHARS * UTF8_MAX_BYTES));
  const handle = fs.openSync(real, "r");
  try {
    fs.readSync(handle, bytes, 0, bytes.length, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return named("binary");
  const text = bytes.toString("utf8");
  const body =
    text.length > FILE_CHARS || size > bytes.length
      ? `${text.slice(0, FILE_CHARS)}\n[… cut at ${String(FILE_CHARS)} characters …]`
      : text;
  return `<file path="${relative}">\n${body}\n</file>`;
}

/**
 * Reads the files a check names.
 * @param globs - Paths or globs, relative to the workspace, by the rules of the file checks: a link that leaves the
 *   workspace is not read, and a path that names a directory means the files under it.
 * @param workspace - The workspace as the run left it.
 * @param attached - The images that are sent with the prompt; each is named as attached. Default: none.
 * @returns One block for each file, once, in path order; a line that says nothing matched when no file did.
 */
export function renderFiles(
  globs: string[],
  workspace: string,
  attached: Attachment[] = [],
): string {
  const sent = new Set(attached.map(({ name }) => name));
  const tree = {
    dir: workspace,
    seed: new Map<string, string>(),
    changed: { created: [], modified: [], deleted: [] },
    name: "workspace" as const,
    unlisted: [],
  };
  const files = new Map<string, string>();
  const notes = new Set<string>();
  for (const glob of globs) {
    const found = find(tree, glob, true);
    for (const entry of found.entries) {
      if (entry.kind === "file") files.set(entry.path, entry.real);
    }
    if (found.capped !== null) {
      notes.add(
        `[… "${glob}" matches more than ${String(GLOB_LIMIT)} paths, so none of it is shown …]`,
      );
    }
    for (const dir of found.unreadable) {
      notes.add(`[… ${dir} cannot be listed …]`);
    }
  }
  const shown =
    files.size === 0
      ? [`No file matches: ${globs.join(", ")}`]
      : [...files]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([relative, real]) => fileBlock(relative, real, sent));
  return [...shown, ...notes].join("\n");
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
 * @param attached - The images that are sent with the prompt. Default: none.
 * @returns The parts to show.
 */
export function materialFor(
  check: {
    sees?: Sees[] | undefined;
    files?: string[] | undefined;
    maxChars?: number | undefined;
  },
  outcome: { transcript: TranscriptEvent[]; workspace: string },
  attached: Attachment[] = [],
): Seen {
  const sees = check.sees ?? (valueOf({ type: "judge" }, "sees") as Sees[]);
  return {
    final: sees.includes("final"),
    ...(sees.includes("transcript")
      ? { transcript: renderTranscript(outcome.transcript, check.maxChars) }
      : {}),
    ...(sees.includes("files")
      ? { files: renderFiles(check.files ?? [], outcome.workspace, attached) }
      : {}),
  };
}
