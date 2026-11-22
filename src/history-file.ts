import fs from "node:fs";
import path from "node:path";
import { HISTORY_SUFFIX } from "./history.js";
import type { History } from "./history-types.js";

const TRANSCRIPT_SUFFIX = ".transcript.json";
const INDENT = 2;

/**
 * Names the history file that goes with a transcript file.
 * @param transcriptFile - The path of `<stem>.transcript.json`.
 * @returns `<stem>.history.json`, in the same directory.
 */
const historyPathOf = (transcriptFile: string): string =>
  `${transcriptFile.slice(0, -TRANSCRIPT_SUFFIX.length)}${HISTORY_SUFFIX}`;

/**
 * Writes the seeded history of a run next to its transcript.
 * @param stem - The run's path without an extension.
 * @param history - The case's history; null for a case with none.
 * @returns The absolute path of the file; null when the case has no history and nothing was written.
 */
export function writeHistory(
  stem: string,
  history: History | null,
): string | null {
  if (history === null) return null;
  const file = path.resolve(`${stem}${HISTORY_SUFFIX}`);
  fs.writeFileSync(file, JSON.stringify(history, null, INDENT));
  return file;
}

/**
 * Finds the history file of a stored run.
 * @param transcriptFile - The absolute path of the run's transcript file.
 * @returns The absolute path of its history file; null when the run has none.
 */
export function existingHistory(transcriptFile: string): string | null {
  const file = historyPathOf(transcriptFile);
  return fs.existsSync(file) ? file : null;
}
