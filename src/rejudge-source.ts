import fs from "node:fs";
import path from "node:path";
import type { Results } from "./evaluate.js";
import { readResultsFile } from "./results-file.js";
import { UsageError } from "./scope.js";
import { RUNS_FILE, readRuns, stemOf } from "./store.js";

/** An earlier command's output directory, read for `rejudge`. */
export interface Source {
  dir: string;
  results: Results;
  /** The run key of each run's last line in `results.jsonl`, by the run's files; the judge cache is scoped by it. */
  keys: Map<string, string>;
}

/**
 * Reads the output directory of an earlier command. It changes nothing.
 * @param dir - The directory.
 * @returns Its results, and the key of each run.
 * @throws {UsageError} When it is not an output directory of this tool, or its results are older than `meta`.
 */
export function readSource(dir: string): Source {
  if (!fs.existsSync(path.join(dir, RUNS_FILE))) {
    throw new UsageError(
      `${dir}: there is no ${RUNS_FILE} in it; rejudge reads the output directory of an earlier run or score`,
    );
  }
  const { results } = readResultsFile(dir);
  if ((results.meta as unknown) === undefined) {
    throw new UsageError(
      `${dir}: these results lack the meta of a newer version; score again`,
    );
  }
  const keys = new Map(
    readRuns(dir).lines.map((line) => [stemOf(line), line.key]),
  );
  return { dir, results, keys };
}
