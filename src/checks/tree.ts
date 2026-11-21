import fs from "node:fs";
import path from "node:path";
import {
  GLOB_LIMIT,
  GlobCapError,
  expandGlob,
  globToRegExp,
  isGlob,
  isMissing,
  literalGlob,
} from "../glob.js";
import type { ChangedFiles, Snapshot } from "../snapshot.js";
import type { Outcome, RuledCheck, Verdict } from "./index.js";

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
  /** Directories, and paths, that could not be looked into for a reason other than not being there. */
  unreadable: string[];
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

// A plain path without its trailing slashes, in normal form.
const plainOf = (pattern: string): string =>
  path.posix.normalize(pattern).replace(/\/+$/, "") || ".";

/**
 * Makes a test of a relative file path for what a check's path names.
 * @param pattern - A glob, or a plain path. A plain path that ends in `/`, or that names a directory, means every
 *   path under it.
 * @param seed - The files the tree held before the run: a plain path is a directory when one starts with it.
 * @param directoryNow - Whether the tree holds a directory at the plain path now.
 * @returns The test, over relative posix paths.
 */
export function scopeTest(
  pattern: string,
  seed: Snapshot,
  directoryNow = false,
): (relative: string) => boolean {
  if (isGlob(pattern)) {
    const expression = globToRegExp(pattern);
    return (relative) => expression.test(relative);
  }
  const plain = plainOf(pattern);
  if (plain === ".") return () => true;
  const below = `${plain}/`;
  const covers =
    pattern.endsWith("/") ||
    directoryNow ||
    [...seed.keys()].some((key) => key.startsWith(below));
  return (relative) =>
    relative === plain || (covers && relative.startsWith(below));
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
 * Makes the function that finds where a path really leads, and whether that is inside the tree.
 * @param dir - The tree's directory.
 * @param unreadable - Receives each path whose lookup failed for a reason other than not being there.
 * @returns A function from a relative path to its real path, or null when the path does not exist or leads outside
 *   the tree through a link.
 */
function resolver(
  dir: string,
  unreadable: string[],
): (relative: string) => string | null {
  const root = fs.realpathSync.native(dir);
  return (relative) => {
    try {
      const real = fs.realpathSync.native(path.join(dir, relative));
      return real === root || real.startsWith(`${root}${path.sep}`)
        ? real
        : null;
    } catch (error) {
      if (!isMissing(error)) unreadable.push(relative);
      return null;
    }
  };
}

/**
 * Lists what a pattern names before links are resolved.
 * @param tree - The tree to look in.
 * @param pattern - A plain path or a glob.
 * @param scope - How to read the pattern, and where to report.
 * @param scope.covered - Whether a plain path that names a directory also names everything under it.
 * @param scope.found - Receives the cap reason and the directories that could not be listed.
 * @returns The relative paths: for a plain path, itself first, then everything under it when it is covered.
 */
function candidates(
  tree: Tree,
  pattern: string,
  scope: { covered: boolean; found: Pick<Found, "capped" | "unreadable"> },
): string[] {
  const { found } = scope;
  const walked = (glob: string): string[] => {
    try {
      return expandGlob(tree.dir, glob, {
        onUnreadable: (relative) =>
          found.unreadable.push(relative === "" ? "." : relative),
      });
    } catch (error) {
      if (!(error instanceof GlobCapError)) throw error;
      found.capped = `the glob "${pattern}" matches more than ${String(GLOB_LIMIT)} paths, which is the cap; narrow the glob`;
      return [];
    }
  };
  if (isGlob(pattern)) return walked(pattern);
  const plain = plainOf(pattern);
  if (!scope.covered && !pattern.endsWith("/")) return [plain];
  return [plain, ...walked(plain === "." ? "**" : `${literalGlob(plain)}/**`)];
}

/**
 * Finds what is at a path or glob now.
 * @param tree - The tree to look in.
 * @param pattern - A plain path or a glob.
 * @param covered - True for a check that reads a plain path naming a directory as everything under it. A path that
 *   ends in `/` is read that way whatever this says.
 * @returns The entries that exist and stay inside the tree, with links resolved; the cap reason when a glob matches
 *   more than the cap; and the directories that could not be listed. A plain path may go through a link that stays
 *   inside the tree. A glob never goes through a link, and a link that leads outside is not an entry. A tree that is
 *   gone has no entries.
 */
export function find(tree: Tree, pattern: string, covered = false): Found {
  const found: Found = { entries: [], capped: null, unreadable: [] };
  try {
    fs.realpathSync.native(tree.dir);
  } catch (error) {
    if (!isMissing(error)) found.unreadable.push(".");
    return found;
  }
  const real = resolver(tree.dir, found.unreadable);
  const slash = !isGlob(pattern) && pattern.endsWith("/");
  const relatives = candidates(tree, pattern, { covered, found });
  found.entries = relatives.flatMap((relative, position): Entry[] => {
    const target = real(relative);
    if (target === null) return [];
    try {
      const stat = fs.statSync(target);
      if (slash && position === 0 && !stat.isDirectory()) return [];
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
  return found;
}

/**
 * Makes the test a change check uses for the path it names, looking at the tree for a directory.
 * @param tree - The tree the check looks at.
 * @param pattern - A glob or a plain path.
 * @returns The test over relative posix paths; see `scopeTest`.
 */
export function treeScope(
  tree: Tree,
  pattern: string,
): (relative: string) => boolean {
  const directoryNow =
    !isGlob(pattern) &&
    find(tree, pattern).entries.some(
      ({ kind, path: at }) => kind === "dir" && at === plainOf(pattern),
    );
  return scopeTest(pattern, tree.seed, directoryNow);
}

/**
 * Narrows what `find` found to one kind.
 * @param found - What `find` returned.
 * @param kind - The kind to keep.
 * @returns The relative paths of that kind.
 */
export const pathsOf = (found: Found, kind: Entry["kind"]): string[] =>
  found.entries.filter((entry) => entry.kind === kind).map(({ path: p }) => p);

/**
 * Says which directories could not be listed, for the end of a reason.
 * @param found - What `find` returned.
 * @returns "" when every directory could be listed, else a clause that names them.
 */
export const unlisted = (found: Found): string =>
  found.unreadable.length === 0
    ? ""
    : `; cannot be listed: ${shown(found.unreadable)}`;

/**
 * Adds the directories that could not be listed to a failing verdict.
 * @param verdict - What a check scored.
 * @param found - What `find` returned for the check's path.
 * @returns The verdict, with its reason ending in the unlisted directories when it scored 0.
 */
export const withUnlisted = (verdict: Verdict, found: Found): Verdict =>
  verdict.score === 0
    ? { ...verdict, reason: `${verdict.reason ?? ""}${unlisted(found)}` }
    : verdict;
