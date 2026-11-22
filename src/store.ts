import fs from "node:fs";
import path from "node:path";
import type { Results } from "./evaluate.js";
import type { RunRecord } from "./run.js";
import { invalidReason } from "./run.js";
import { UsageError } from "./scope.js";

/** The file with one line for each finished run. */
export const RUNS_FILE = "results.jsonl";
const RESULTS_FILE = "results.json";

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
  /**
   * Reads `results.jsonl` for a resume: for each `slotName`, the last record that counts as a valid run. A last line that is
   * not valid JSON is dropped, with one warning, and removed from the file so that the next append starts a line.
   * @throws {UsageError} When a line before the last is not valid JSON.
   */
  load: () => Map<string, RunRecord>;
}

/** What `results.jsonl` holds. */
interface Read {
  /** Every whole line, in file order. */
  lines: StoredRun[];
  /** The text of those lines, each ended by a newline. */
  text: string;
  /** True when a last line was not valid JSON and is left out. */
  dropped: boolean;
}

/**
 * Parses one line of `results.jsonl`.
 * @param line - The text.
 * @returns The stored run; null when the text is not JSON, or not a run with a key and an attempt.
 */
function parseLine(line: string): StoredRun | null {
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== "object") return null;
    const { key, attempt, checks } = value as Partial<StoredRun>;
    return typeof key === "string" &&
      typeof attempt === "number" &&
      Array.isArray(checks)
      ? (value as StoredRun)
      : null;
  } catch {
    return null;
  }
}

/**
 * Reads `results.jsonl` of an output directory. It changes nothing.
 * @param outDir - The output directory.
 * @returns The whole lines, and whether a damaged last line was left out.
 * @throws {UsageError} When a line before the last is not valid JSON, naming its number.
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
      const target = path.join(outDir, RESULTS_FILE);
      fs.writeFileSync(`${target}.tmp`, JSON.stringify(results, null, "\t"));
      fs.renameSync(`${target}.tmp`, target);
    },
    load: () => {
      const read = readRuns(outDir);
      if (read.dropped) {
        console.error(
          `skill-evals: warning: the last line of ${runs} is not valid JSON, so it was dropped and its run will repeat`,
        );
      }
      if (fs.readFileSync(runs, "utf8") !== read.text) {
        fs.writeFileSync(runs, read.text);
      }
      const kept = new Map<string, RunRecord>();
      for (const line of read.lines) {
        const record = recordOf(line);
        if (invalidReason(record) === null)
          kept.set(slotName(line.key, record.subject), record);
      }
      return kept;
    },
  };
}
