import fs from "node:fs";
import path from "node:path";
import type { Results } from "./evaluate.js";
import { UsageError, isObject, messageOf } from "./scope.js";

/** The file that a command writes its results to. */
const RESULTS_FILE = "results.json";

/**
 * Reads the results of a command.
 * @param where - An output directory, or the path of a `results.json`.
 * @returns The parsed results and the directory that holds them.
 * @throws {UsageError} When there is no such file, it is not JSON, or it is not results of this tool: `schemaVersion` 1
 *   with a `records` list.
 */
export function readResultsFile(where: string): {
  results: Results;
  dir: string;
  file: string;
} {
  const given = path.resolve(where);
  const file =
    fs.existsSync(given) && fs.statSync(given).isDirectory()
      ? path.join(given, RESULTS_FILE)
      : given;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new UsageError(
      `${file}: cannot read the results: ${messageOf(error)}`,
    );
  }
  if (
    !isObject(parsed) ||
    parsed["schemaVersion"] !== 1 ||
    !Array.isArray(parsed["records"])
  ) {
    throw new UsageError(
      `${file}: not the results of skill-evals: expected schemaVersion 1 and a list of records`,
    );
  }
  return {
    results: parsed as unknown as Results,
    dir: path.dirname(file),
    file,
  };
}
