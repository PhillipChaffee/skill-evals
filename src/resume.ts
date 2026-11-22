import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./scope.js";
import { RUNS_FILE } from "./store.js";

/**
 * Checks `--resume` before any work starts.
 * @param options - `outDir` is `--out`; `resume` is `--resume`, which implies `--out`.
 * @param options.outDir - The directory the user asked for.
 * @param options.resume - The directory of an earlier command, which holds `results.jsonl`.
 * @param cwd - What a relative directory resolves against.
 * @returns The absolute directory to continue in; undefined without `resume`.
 * @throws {UsageError} When both are given and name different directories, or `resume` holds no `results.jsonl`.
 */
export function resumeDir(
  options: { outDir?: string | undefined; resume?: string | undefined },
  cwd: string,
): string | undefined {
  const { outDir, resume } = options;
  if (resume === undefined) return undefined;
  const dir = path.resolve(cwd, resume);
  if (outDir !== undefined && path.resolve(cwd, outDir) !== dir) {
    throw new UsageError(
      `--resume ${resume} implies --out ${resume}, so --out ${outDir} must name the same directory`,
    );
  }
  if (!fs.existsSync(path.join(dir, RUNS_FILE))) {
    throw new UsageError(
      `--resume ${resume}: there is no ${RUNS_FILE} in it; it is the output directory of an earlier run or score`,
    );
  }
  return dir;
}
