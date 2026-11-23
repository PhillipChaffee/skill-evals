import fs from "node:fs";
import path from "node:path";
import { nameProblem } from "./case-id.js";
import { UsageError } from "./scope.js";

const ONE = 1;

/** One directory that holds cases. */
export interface CaseRoot {
  /** The absolute path. */
  dir: string;
  /** True for a root from `--heldout-cases`: every case in it is held out. */
  heldout: boolean;
}

/** The options that name case roots, after the config file was applied. */
export interface RootOptions {
  /** The absolute paths of the cases directories. */
  cases: string[];
  /** The absolute paths of the held-out cases directories. */
  heldoutCases?: string[];
}

/**
 * Turns a value that is one text or a list of texts into a list.
 * @param value - A text, a list of texts, or nothing.
 * @returns The list; empty for nothing.
 */
export const listOf = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : [value].flat();

/**
 * Resolves a directory's links, if it exists.
 * @param dir - A path that may not exist.
 * @returns Its real path, or its absolute path when it cannot be resolved.
 */
function realOf(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Tells whether a directory is the same as another or holds it.
 * @param outer - A real path.
 * @param inner - Another real path.
 * @returns True when `inner` is `outer` or is below it.
 */
function holds(outer: string, inner: string): boolean {
  const down = path.relative(outer, inner);
  return down === "" || !(down.startsWith("..") || path.isAbsolute(down));
}

/**
 * Names the roots of a command.
 * @param options - The cases directories and the held-out ones.
 * @returns The roots, the held-out ones last.
 * @throws {UsageError} When one root is, or holds, another (compared by real path, links included), because a case
 *   would be listed twice or a held-out case would be taken for a dev case; when two roots have the same basename,
 *   because their ids would clash; or, with more than one root, when a basename could not be a part of a case id.
 *   Each message names the directories.
 */
export function rootsOf(options: RootOptions): CaseRoot[] {
  const roots = [
    ...options.cases.map((dir) => ({ dir, heldout: false })),
    ...(options.heldoutCases ?? []).map((dir) => ({ dir, heldout: true })),
  ];
  if (roots.length <= ONE) return roots;
  const seen = new Map<string, string>();
  roots.forEach(({ dir }, index) => {
    const real = realOf(dir);
    for (const other of roots.slice(index + ONE)) {
      const there = realOf(other.dir);
      if (holds(real, there) || holds(there, real)) {
        throw new UsageError(
          `the cases directories ${dir} and ${other.dir} overlap: one is, or holds, the other, so a case would be found twice or a held-out case taken for a dev case; name directories that are apart`,
        );
      }
    }
  });
  for (const { dir } of roots) {
    const name = path.basename(dir);
    const first = seen.get(name);
    if (first !== undefined) {
      throw new UsageError(
        `the cases directories ${first} and ${dir} have the same name "${name}", so their case ids would clash; rename the directory`,
      );
    }
    const problem = nameProblem(name);
    if (problem !== null) {
      throw new UsageError(
        `the cases directory ${dir} would start every case id with its name, and ${problem}; rename the directory`,
      );
    }
    seen.set(name, dir);
  }
  return roots;
}

/**
 * Says what a root adds in front of the ids of its cases.
 * @param root - One of the roots.
 * @param roots - Every root of the command.
 * @returns The root's basename, when there is more than one root; else nothing, so that the ids of a single root do
 *   not change.
 */
export const prefixOf = (root: CaseRoot, roots: CaseRoot[]): string | null =>
  roots.length > ONE ? path.basename(root.dir) : null;

/**
 * Lists the directories of the roots.
 * @param roots - Case roots, held-out ones included.
 * @returns The absolute path of each, in the order of the roots.
 */
export const dirsOf = (roots: CaseRoot[]): string[] =>
  roots.map(({ dir }) => dir);

/**
 * Checks that no id is used twice.
 * @param ids - The ids of every loaded case.
 * @returns The ids that were used twice, and no other; empty when all are different.
 */
export function repeatedIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const again = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) again.add(id);
    seen.add(id);
  }
  return [...again].sort();
}
