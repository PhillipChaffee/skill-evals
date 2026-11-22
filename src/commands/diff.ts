import path from "node:path";
import { diffResults } from "../diff.js";
import { renderDiff } from "../diff-render.js";
import { EXIT } from "../exit-codes.js";
import type { Project } from "../project.js";
import { readResultsFile } from "../results-file.js";
import type { Options } from "../usage.js";

/**
 * The `diff` command: compares two sets of results and prints what changed as markdown. It informs and does not gate:
 * the exit code is 0, unless `--strict` is set and the two results differ in a way that makes them an unfair pair.
 * @param options - The command line's options.
 * @param project - Where relative paths resolve from.
 * @param args - The two results: output directories or `results.json` paths.
 * @returns 0; with `--strict` and a warning, 2.
 * @throws {UsageError} When a path holds no results of this tool.
 */
export function diff(
  options: Options,
  project: Pick<Project, "cwd">,
  args: string[],
): number {
  const [first = "", second = ""] = args;
  const a = readResultsFile(path.resolve(project.cwd, first));
  const b = readResultsFile(path.resolve(project.cwd, second));
  const found = diffResults(a.results, b.results);
  console.log(renderDiff(found, { a: a.file, b: b.file }));
  if (options.strict === true && found.warnings.length > 0) {
    console.error(
      `skill-evals: --strict: ${String(found.warnings.length)} warnings, so the exit code is ${String(EXIT.usage)}`,
    );
    return EXIT.usage;
  }
  return EXIT.ok;
}
