import path from "node:path";
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
 * Names the roots of a command.
 * @param options - The cases directories and the held-out ones.
 * @returns The roots, the held-out ones last.
 * @throws {UsageError} When two roots have the same basename, because their ids would clash; the message names both.
 */
export function rootsOf(options: RootOptions): CaseRoot[] {
  const roots = [
    ...options.cases.map((dir) => ({ dir, heldout: false })),
    ...(options.heldoutCases ?? []).map((dir) => ({ dir, heldout: true })),
  ];
  if (roots.length <= ONE) return roots;
  const seen = new Map<string, string>();
  for (const { dir } of roots) {
    const name = path.basename(dir);
    const first = seen.get(name);
    if (first !== undefined) {
      throw new UsageError(
        `the cases directories ${first} and ${dir} have the same name "${name}", so their case ids would clash; rename one`,
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
