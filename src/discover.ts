import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./scope.js";

/** One case directory that discovery found. */
export interface Found {
  /** The path of the directory below the cases directory, with `/`. */
  id: string;
  dir: string;
}

const isCaseDir = (dir: string): boolean =>
  ["prompt.md", "case.json"].some((name) =>
    fs.existsSync(path.join(dir, name)),
  );

/**
 * Finds the case directories under a directory, at any depth. A directory is a case when it holds `prompt.md` or
 * `case.json`. Nothing under a case is searched, and a directory whose name starts with `_` is skipped with all it holds.
 * @param dir - The directory to search.
 * @param prefix - The names of the directories above it, below the cases directory.
 * @returns The cases, unsorted.
 * @throws {UsageError} When a directory cannot be read, or the name of a case's directory holds `@` or `,`.
 */
export function discover(dir: string, prefix: string[] = []): Found[] {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    throw new UsageError(
      prefix.length === 0
        ? `cannot read the cases directory ${dir} (${String(code)}); create it or pass --cases`
        : `cannot read ${dir} (${String(code)})`,
    );
  }
  return entries.flatMap((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith("_")) return [];
    const where = path.join(dir, entry.name);
    const names = [...prefix, entry.name];
    if (!isCaseDir(where)) return discover(where, names);
    const id = names.join("/");
    if (names.some((name) => /[@,]/.test(name))) {
      throw new UsageError(
        `case ${id}: a directory name may not hold "@" or ","`,
      );
    }
    return [{ id, dir: where }];
  });
}
