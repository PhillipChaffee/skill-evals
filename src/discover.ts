import fs from "node:fs";
import path from "node:path";
import { nameProblem } from "./case-id.js";
import { UsageError } from "./scope.js";

/** One case directory that discovery found. */
export interface Found {
  /** The path of the directory below the cases directory, with `/`. */
  id: string;
  dir: string;
}

/**
 * Tells whether a directory holds the files of a case.
 * @param dir - The directory.
 * @returns True when it holds `prompt.md` or `case.json`.
 */
export const isCaseDir = (dir: string): boolean =>
  ["prompt.md", "case.json"].some((name) =>
    fs.existsSync(path.join(dir, name)),
  );

/**
 * Tells whether discovery skips a directory by its name, with all it holds.
 * @param name - The directory's name.
 * @returns True for a name that starts with `_`.
 */
export const isSkippedName = (name: string): boolean => name.startsWith("_");

/**
 * Finds the case directories under a directory, at any depth. A directory is a case when it holds `prompt.md` or
 * `case.json`. Nothing under a case is searched, and a directory whose name starts with `_` is skipped with all it holds.
 * @param dir - The directory to search.
 * @param prefix - The names of the directories above it, below the cases directory.
 * @param onError - Collecting mode: hears of each fault with the case's id, or the directory when it has none, and
 *   discovery goes on without that directory. Absent: the first fault throws.
 * @returns The cases, unsorted.
 * @throws {UsageError} When a directory cannot be read, or the name of a case's directory holds `@`, `,` or a control character, or is over 255 bytes, and
 *   `onError` is absent.
 */
export function discover(
  dir: string,
  prefix: string[] = [],
  onError?: (caseId: string, message: string) => void,
): Found[] {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    const message =
      prefix.length === 0
        ? `cannot read the cases directory ${dir} (${String(code)}); create it or pass --cases`
        : `cannot read ${dir} (${String(code)})`;
    if (!onError) throw new UsageError(message);
    onError(dir, message);
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.isDirectory() || isSkippedName(entry.name)) return [];
    const where = path.join(dir, entry.name);
    const names = [...prefix, entry.name];
    if (!isCaseDir(where)) return discover(where, names, onError);
    const id = names.join("/");
    const [problem] = names.flatMap((name) => nameProblem(name) ?? []);
    if (problem !== undefined) {
      const message = `case ${id}: ${problem}`;
      if (!onError) throw new UsageError(message);
      onError(id, message);
      return [];
    }
    return [{ id, dir: where }];
  });
}

/**
 * Tells whether a case's file declares variants, without reading the case in full.
 * @param dir - The case's directory.
 * @returns True when `case.json` has a `variants` key. A file that is missing declares none. A file that cannot be read or parsed counts as true, so that
 *   loading the case reports the fault and no variant is dropped without a word.
 */
export function declaresVariants(dir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, "case.json"), "utf8"),
    );
    return (
      typeof parsed === "object" && parsed !== null && "variants" in parsed
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
