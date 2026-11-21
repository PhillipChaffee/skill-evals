import fs from "node:fs";
import path from "node:path";
import { GLOB_LIMIT, expandGlob, globToRegExp } from "../glob.js";
import type { ChangedFiles, Snapshot } from "../snapshot.js";
import type { Outcome, RuledCheck } from "./index.js";

/** One of the two trees a file check can look at. */
export interface Tree {
  /** The directory as the run left it; it may be gone. */
  dir: string;
  /** What it held before the harness started. */
  seed: Snapshot;
  changed: ChangedFiles;
  /** The word a reason uses for it. */
  name: "workspace" | "home";
}

/** One thing that a path or glob names and that lies inside its tree. */
interface Entry {
  /** The relative posix path. */
  path: string;
  /** The real path of the file, with every link resolved. */
  real: string;
  kind: "file" | "dir" | "other";
}

/** What a path or glob found. */
export interface Found {
  entries: Entry[];
  /** The reason that scores 0 when the glob matched more paths than the cap; null otherwise. */
  capped: string | null;
}

const SHOWN_PATHS = 10;

/**
 * Picks the tree a check names.
 * @param check - A check, whose `root` is the workspace when absent.
 * @param outcome - What the run left behind.
 * @returns The workspace or the home, with its seed and its changes.
 */
export const treeOf = (check: RuledCheck, outcome: Outcome): Tree =>
  check.root === "home"
    ? {
        dir: outcome.home,
        seed: outcome.homeSeed,
        changed: outcome.homeChanged,
        name: "home",
      }
    : {
        dir: outcome.workspace,
        seed: outcome.seed,
        changed: outcome.changed,
        name: "workspace",
      };

/**
 * Tells a glob from a plain path.
 * @param pattern - The `path` of a check.
 * @returns True when it holds `*`, `?` or `{`.
 */
const isGlob = (pattern: string): boolean => /[*?{]/.test(pattern);

/**
 * Makes a test of a relative path that a check's path or glob names.
 * @param pattern - A plain path, which only itself matches, or a glob.
 * @returns The test, over relative posix paths.
 */
export function pathTest(pattern: string): (relative: string) => boolean {
  if (!isGlob(pattern)) {
    const plain = path.posix.normalize(pattern);
    return (relative) => relative === plain;
  }
  const expression = globToRegExp(pattern);
  return (relative) => expression.test(relative);
}

/**
 * Lists paths for a reason, so that a long list stays readable.
 * @param paths - The paths involved.
 * @returns The first ten, joined by commas, and "and N more" for the rest.
 */
export function shown(paths: string[]): string {
  const more = paths.length - SHOWN_PATHS;
  const head = paths.slice(0, SHOWN_PATHS).join(", ");
  return more > 0 ? `${head} and ${String(more)} more` : head;
}

/**
 * Makes the test that finds where a path really leads, and whether that is inside the tree.
 * @param dir - The tree's directory.
 * @returns A function from a relative path to its real path, or null when the path does not exist, or leads outside
 *   the tree through a link, or the tree is gone.
 */
function resolver(dir: string): (relative: string) => string | null {
  let root: string;
  try {
    root = fs.realpathSync.native(dir);
  } catch {
    return () => null;
  }
  return (relative) => {
    try {
      const real = fs.realpathSync.native(path.join(dir, relative));
      return real === root || real.startsWith(`${root}${path.sep}`)
        ? real
        : null;
    } catch {
      return null;
    }
  };
}

/**
 * Finds what is at a path or glob now.
 * @param tree - The tree to look in.
 * @param pattern - A plain path or a glob.
 * @returns The entries that exist and stay inside the tree, with links resolved; or, when a glob matches more than
 *   the cap, the reason. A plain path may go through a link that stays inside the tree. A glob never goes through
 *   a link, and a link that leads outside is not an entry.
 */
export function find(tree: Tree, pattern: string): Found {
  let relatives: string[];
  if (isGlob(pattern)) {
    try {
      relatives = expandGlob(tree.dir, pattern);
    } catch {
      return {
        entries: [],
        capped: `the glob "${pattern}" matches more than ${String(GLOB_LIMIT)} paths, which is the cap; narrow the glob`,
      };
    }
  } else {
    relatives = [path.posix.normalize(pattern)];
  }
  const real = resolver(tree.dir);
  const entries = relatives.flatMap((relative): Entry[] => {
    const target = real(relative);
    if (target === null) return [];
    try {
      const stat = fs.statSync(target);
      const kind = stat.isFile()
        ? "file"
        : stat.isDirectory()
          ? "dir"
          : "other";
      return [{ path: relative, real: target, kind }];
    } catch {
      return [];
    }
  });
  return { entries, capped: null };
}

/**
 * Narrows what `find` found to one kind.
 * @param found - What `find` returned.
 * @param kind - The kind to keep.
 * @returns The relative paths of that kind.
 */
export const pathsOf = (found: Found, kind: Entry["kind"]): string[] =>
  found.entries.filter((entry) => entry.kind === kind).map(({ path: p }) => p);
