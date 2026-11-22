import fs from "node:fs";
import path from "node:path";
import type { Results } from "./evaluate.js";
import type { RunRecord } from "./run.js";
import { invalidReason } from "./run.js";
import { UsageError } from "./scope.js";
import { isStoredRun } from "./store-shape.js";
import type { Summary } from "./summary.js";

/** The file with one line for each finished run. */
export const RUNS_FILE = "results.jsonl";
const RESULTS_FILE = "results.json";
const SUMMARY_FILE = "summary.json";

/** A run record with the key of its question and the number of the attempt that made it. */
export type StoredRun = RunRecord & { key: string; attempt: number };

/**
 * Takes the key and the attempt off a stored run.
 * @param line - A line of `results.jsonl`.
 * @returns The run record, as `results.json` holds it.
 */
export const recordOf = (line: StoredRun): RunRecord =>
  Object.fromEntries(
    Object.entries(line).filter(
      ([name]) => name !== "key" && name !== "attempt",
    ),
  ) as unknown as RunRecord;

/**
 * Names the place of a stored run in a plan: its key and its subject's label. Two subjects with the same content have
 * the same key, so the label tells their runs apart.
 * @param key - The run key.
 * @param label - The subject's label.
 * @returns The name under which `load` holds the run.
 */
export const slotName = (key: string, label: string): string =>
  `${key}/${label}`;

/** The incremental results of one output directory. */
export interface Store {
  /** Adds one line to `results.jsonl`, with one `appendFileSync` call from the main process. */
  append: (line: StoredRun) => void;
  /** Rewrites `results.json` through `results.json.tmp` and a rename, so it is whole or the earlier one. */
  flush: (results: Results) => void;
  /** The last write of a command, whatever way it ended: `flush`, then `summary.json` the same way. Interim writes never touch the summary. */
  finish: (results: Results, summary: Summary) => void;
  /** Writes `summary.json` alone, after the reports, which the last write of a command that ran to the end waits for. */
  writeSummary: (summary: Summary) => void;
  /**
   * Reads `results.jsonl` for a resume: the records that `reusable` finds. A last line that is not a valid run is
   * dropped, with one warning, and removed from the file so that the next append starts a line.
   * @throws {UsageError} When a line before the last is not a valid run.
   */
  load: () => Map<string, RunRecord>;
}

/** What `results.jsonl` holds. */
interface Read {
  /** Every whole line, in file order. */
  lines: StoredRun[];
  /** The text of those lines, each ended by a newline. */
  text: string;
  /** True when a last line was not a valid run and is left out. */
  dropped: boolean;
}

/**
 * Parses one line of `results.jsonl`.
 * @param line - The text.
 * @returns The stored run; null when the text is not JSON, or lacks the shape of a run record.
 */
function parseLine(line: string): StoredRun | null {
  try {
    const value: unknown = JSON.parse(line);
    return isStoredRun(value) ? (value as StoredRun) : null;
  } catch {
    return null;
  }
}

/**
 * Reads `results.jsonl` of an output directory. It changes nothing.
 * @param outDir - The output directory.
 * @returns The whole lines, and whether a damaged last line was left out.
 * @throws {UsageError} When a line before the last is not a valid run, naming its number.
 */
export function readRuns(outDir: string): Read {
  const file = path.join(outDir, RUNS_FILE);
  const rows = fs.readFileSync(file, "utf8").split("\n");
  if (rows.at(-1) === "") rows.pop();
  const lines: StoredRun[] = [];
  let dropped = false;
  for (const [index, row] of rows.entries()) {
    const line = parseLine(row);
    if (line !== null) lines.push(line);
    else if (index === rows.length - 1) dropped = true;
    else {
      throw new UsageError(
        `${file}: line ${String(index + 1)} is not a valid run record; only the last line may be cut short`,
      );
    }
  }
  return {
    lines,
    text: rows
      .slice(0, rows.length - Number(dropped))
      .map((row) => `${row}\n`)
      .join(""),
    dropped,
  };
}

/**
 * Names the files a run writes: its harness, case, subject label and rep.
 * @param run - A run record or a stored run.
 * @returns The stem; two runs with one stem write the same files.
 */
export const stemOf = (
  run: Pick<RunRecord, "harness" | "caseId" | "subject" | "rep">,
): string => [run.harness, run.caseId, run.subject, run.rep].join("\n");

/**
 * Finds the records that a resume may reuse. A record is reused only when it is valid and is the last line of its
 * stem: a later run of the same stem may have overwritten the files that the record points at.
 * @param lines - The lines of `results.jsonl`, in file order.
 * @returns The records by `slotName`.
 */
export function reusable(lines: StoredRun[]): Map<string, RunRecord> {
  const last = new Map<string, StoredRun>();
  for (const line of lines) last.set(stemOf(line), line);
  const kept = new Map<string, RunRecord>();
  for (const line of last.values()) {
    const record = recordOf(line);
    if (invalidReason(record) === null) {
      kept.set(slotName(line.key, record.subject), record);
    }
  }
  return kept;
}

/**
 * Refuses an output directory that holds the runs of an earlier command, which a fresh command would empty.
 * @param outDir - The output directory.
 * @throws {UsageError} When `results.jsonl` exists and has a line, naming how many runs it holds.
 */
export function requireFresh(outDir: string): void {
  const file = path.join(outDir, RUNS_FILE);
  if (!fs.existsSync(file)) return;
  const held = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "").length;
  if (held > 0) {
    throw new UsageError(
      `${outDir} holds ${String(held)} runs of an earlier command; pass --resume ${outDir}, remove ${RUNS_FILE}, or choose another --out`,
    );
  }
}

/**
 * Writes a JSON file whole or not at all.
 * @param target - The file.
 * @param value - What it holds.
 */
export function writeAtomic(target: string, value: unknown): void {
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(value, null, "\t"));
  fs.renameSync(`${target}.tmp`, target);
}

/**
 * Opens the incremental results of an output directory.
 * @param outDir - The output directory, which exists.
 * @param resume - False for a fresh run, which starts an empty `results.jsonl`; true to keep the file and read it.
 * @returns The store; its `load` is for a resume.
 */
export function openStore(outDir: string, resume: boolean): Store {
  const runs = path.join(outDir, RUNS_FILE);
  if (!resume) fs.writeFileSync(runs, "");
  return {
    append: (line) => {
      fs.appendFileSync(runs, `${JSON.stringify(line)}\n`);
    },
    flush: (results) => {
      writeAtomic(path.join(outDir, RESULTS_FILE), results);
    },
    finish: (results, summary) => {
      writeAtomic(path.join(outDir, RESULTS_FILE), results);
      writeAtomic(path.join(outDir, SUMMARY_FILE), summary);
    },
    writeSummary: (summary) => {
      writeAtomic(path.join(outDir, SUMMARY_FILE), summary);
    },
    load: () => {
      const read = readRuns(outDir);
      if (read.dropped) {
        console.error(
          `skill-evals: warning: the last line of ${runs} is not a valid run record, so it was dropped and its run will repeat`,
        );
      }
      if (fs.readFileSync(runs, "utf8") !== read.text) {
        fs.writeFileSync(`${runs}.tmp`, read.text);
        fs.renameSync(`${runs}.tmp`, runs);
      }
      return reusable(read.lines);
    },
  };
}
