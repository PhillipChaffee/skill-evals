import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { globToRegExp } from "./glob.js";
import { UsageError, tempDir } from "./scope.js";
import type { ChangedFiles, Snapshot } from "./snapshot.js";
import {
  allChanged,
  diffSnapshots,
  mergeChanges,
  snapshot,
} from "./snapshot.js";
import { walkTree } from "./walk.js";

// Never part of a subject, at any depth.
const ALWAYS_LEFT_OUT = new Set([".git", "node_modules"]);

/**
 * Builds the test for the paths an export leaves out.
 * @param globs - Globs relative to the subject's root, each matching a whole path; a directory that matches is left
 *   out with everything in it, and one that ends in `/**` also leaves out the directory itself.
 * @returns Tells a relative posix path that is left out: `.git` and `node_modules` at any depth, or a match of a glob.
 */
export function leaveOut(globs: string[]): (relative: string) => boolean {
  // A glob that ends in `/**` also matches the directory itself, so that no empty directory stays behind.
  const matchers = globs.flatMap((glob) => {
    const whole = glob.replace(/\/+$/, "");
    const directory = whole.replace(/\/\*\*$/, "");
    return [whole, directory].map((each) => globToRegExp(each));
  });
  return (relative) =>
    ALWAYS_LEFT_OUT.has(relative.slice(relative.lastIndexOf("/") + 1)) ||
    matchers.some((matcher) => matcher.test(relative));
}

/**
 * Runs a program that the export needs.
 * @param program - `git` or `tar`.
 * @param args - Its arguments, passed as they are with no shell.
 * @param purpose - What the program does, for the message of a failure.
 * @throws {UsageError} When the program is not installed or exits with an error.
 */
function run(program: string, args: string[], purpose: string): void {
  const ran = spawnSync(program, args, { encoding: "utf8" });
  if (ran.error) {
    const missing = (ran.error as NodeJS.ErrnoException).code === "ENOENT";
    throw new UsageError(
      missing
        ? `${program} is needed to export a git ref and was not found on PATH; install it, or pass a directory`
        : `${program} could not run: ${ran.error.message}`,
    );
  }
  if (ran.status !== 0) {
    throw new UsageError(`${purpose} failed: ${ran.stderr.trim()}`);
  }
}

/**
 * Writes the files of a commit into a directory, leaving out what `export-ignore` marks.
 * @param repoRoot - The repository.
 * @param commit - The full hash.
 * @param into - An empty directory.
 */
function extractCommit(repoRoot: string, commit: string, into: string): void {
  // The equivalent of `git archive | tar -x`. The archive passes through a file because the export is synchronous.
  const scratch = tempDir("kit-");
  try {
    const archive = path.join(scratch.dir, "files.tar");
    run(
      "git",
      ["-C", repoRoot, "archive", "--format=tar", "-o", archive, commit],
      "git archive",
    );
    run("tar", ["-x", "-f", archive, "-C", into], "tar -x");
  } finally {
    scratch.dispose();
  }
}

const parentOf = (relative: string): string =>
  relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";

/**
 * Removes what an export leaves out from a tree that was extracted whole.
 * @param root - The tree.
 * @param left - Tells a relative posix path that goes.
 */
function prune(root: string, left: (relative: string) => boolean): void {
  walkTree(root, {
    visit: ({ relative, file }) => {
      if (!left(relative)) return undefined;
      fs.rmSync(file, { recursive: true, force: true });
      return false;
    },
  });
}

/**
 * Finds the directories of a tree that have something in them.
 * @param root - The tree.
 * @returns The relative paths of those directories; the root is "".
 */
function nonEmptyDirs(root: string): Set<string> {
  const found = new Set<string>();
  walkTree(root, {
    visit: ({ relative }) => {
      found.add(parentOf(relative));
      return undefined;
    },
  });
  return found;
}

/**
 * Removes the directories that an export left empty only because it left something out, so that the path of an
 * excluded directory does not show. A directory that was empty at the source stays.
 * @param root - The export.
 * @param hadEntries - Tells whether a directory, by relative path, had something in it at the source.
 */
function removeEmptied(
  root: string,
  hadEntries: (relative: string) => boolean,
): void {
  const dirs: string[] = [];
  walkTree(root, {
    visit: ({ relative, dirent }) => {
      if (dirent.isDirectory()) dirs.push(relative);
      return undefined;
    },
  });
  // Children come after their parent in the list, so walking it backwards empties a parent before it is looked at.
  for (const relative of dirs.reverse()) {
    const dir = path.join(root, relative);
    if (fs.readdirSync(dir).length === 0 && hadEntries(relative)) {
      fs.rmdirSync(dir);
    }
  }
}

/**
 * Finds where a link really leads, following every link on the way, even when the end does not exist.
 * @param link - The path of the link, in a tree whose own directories are not links.
 * @param target - What the link says.
 * @returns The real path, or for a path that does not exist the real path of its deepest existing part and the rest.
 */
function leadsTo(link: string, target: string): string {
  const parts = `${path.dirname(link)}/${target}`.split("/");
  for (let used = parts.length; used > 0; used--) {
    try {
      // The native call follows a link before it applies `..`, as the operating system does; the other one does not.
      const real = fs.realpathSync.native(
        parts.slice(0, used).join("/") || "/",
      );
      return path.resolve(real, ...parts.slice(used));
    } catch {
      // A part that does not exist, or a loop of links: try the part before it.
    }
  }
  return path.resolve(target);
}

/**
 * Makes sure that no link of a tree leads out of it, however many links it goes through. A link that is absolute
 * would reach the source directory from a copy, so it counts as outside, too.
 * @param root - The tree.
 * @param owner - What the tree is, for the message. Default: "the subject".
 * @throws {UsageError} Naming the first link whose target is absolute, or leads outside the tree.
 */
export function requireLinksInside(root: string, owner = "the subject"): void {
  const real = fs.realpathSync.native(root);
  walkTree(root, {
    visit: ({ relative, file, dirent }) => {
      if (!dirent.isSymbolicLink()) return undefined;
      const target = fs.readlinkSync(file);
      const leaves = path.relative(real, leadsTo(file, target));
      if (
        path.isAbsolute(target) ||
        leaves === ".." ||
        leaves.startsWith(`..${path.sep}`)
      ) {
        throw new UsageError(
          `${relative} is a link to ${target}${path.isAbsolute(target) ? ", an absolute path" : ""}; links outside ${owner} are not allowed`,
        );
      }
      return undefined;
    },
  });
}

/**
 * Refuses an entry that is no file, directory or link, which a copy cannot hold.
 * @param file - The path in the source.
 * @throws {UsageError} Naming the path, for a socket, a FIFO or a device.
 */
function requireRegular(file: string): void {
  const entry = fs.lstatSync(file);
  if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()) {
    throw new UsageError(
      `${file} is a socket, a pipe or a device, which a subject cannot hold; remove it or list it in subjectExclude`,
    );
  }
}

/** Where a subject's files are. */
interface Source {
  /** The directory to copy; for a commit, the repository, which the commit is looked up in. */
  dir: string;
  /** The full hash of the commit to export, or null to copy `dir` as it is on disk. */
  commit: string | null;
  repoRoot: string;
}

/** What an export is. */
export interface Export {
  dir: string;
  /** Hashes the export again and lists what differs from when it was made; nothing, unless a run edited it. */
  changed: () => string[];
  dispose: () => void;
}

/**
 * Copies a directory as it is on disk.
 * @param source - The directory to copy.
 * @param into - An empty directory.
 * @param left - Tells a relative posix path that is left out.
 * @throws {UsageError} When an entry cannot be copied, naming it.
 */
function copyDirectory(
  source: string,
  into: string,
  left: (relative: string) => boolean,
): void {
  try {
    fs.cpSync(source, into, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (file) => {
        const relative = path.relative(source, file).split(path.sep).join("/");
        if (relative !== "" && left(relative)) return false;
        requireRegular(file);
        return true;
      },
    });
    removeEmptied(
      into,
      (relative) => fs.readdirSync(path.join(source, relative)).length > 0,
    );
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(
      `cannot copy the subject ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Exports a subject to a temp directory, so that nothing loads from the source in place.
 * A directory is copied, with links kept as links. A commit is written with `git archive` and `tar`, which honours
 * `export-ignore`. A directory that is empty only because of what was left out is removed.
 * @param source - What to export.
 * @param exclude - Globs, relative to the root of the subject, of what to leave out besides `.git` and `node_modules`.
 * @returns The export; its `dispose` also runs at process exit.
 * @throws {UsageError} When `git` or `tar` is missing, an entry cannot be copied, or a link of the subject leads
 *   outside it.
 */
export function exportSubject(source: Source, exclude: string[]): Export {
  const left = leaveOut(exclude);
  const out = tempDir("kit-");
  try {
    if (source.commit) {
      extractCommit(source.repoRoot, source.commit, out.dir);
      const had = nonEmptyDirs(out.dir);
      prune(out.dir, left);
      removeEmptied(out.dir, (relative) => had.has(relative));
    } else {
      copyDirectory(source.dir, out.dir, left);
    }
    requireLinksInside(out.dir);
  } catch (error) {
    out.dispose();
    throw error;
  }
  const before = snapshot(out.dir);
  return {
    ...out,
    changed: () => allChanged(diffSnapshots(before, snapshot(out.dir))),
  };
}

/** One run's copy of an export, which the run may edit. */
export interface RunCopy {
  dir: string;
  /** Hashes the copy again and lists what the run changed in it, against the hashes taken when it was made. */
  changes: () => ChangedFiles;
  dispose: () => void;
}

/**
 * Copies an export for one run, so that what the run edits never reaches another run.
 * @param exported - The directory `exportSubject` returned.
 * @returns The copy, in a temp directory whose name gives the agent no hint of why it exists.
 */
export function copyForRun(exported: string): RunCopy {
  const copy = tempDir("kit-");
  try {
    fs.cpSync(exported, copy.dir, { recursive: true, verbatimSymlinks: true });
  } catch (error) {
    copy.dispose();
    throw error;
  }
  const before = snapshot(copy.dir);
  return {
    ...copy,
    changes: () => diffSnapshots(before, snapshot(copy.dir)),
  };
}

/**
 * Hashes directories now, for a comparison after the harness has run.
 * @param dirs - Each directory, and the path that its contents have inside the subject.
 * @returns A function that hashes them again and lists what changed, with every path put under its directory's prefix.
 */
export function watchDirs(
  dirs: { dir: string; prefix: string }[],
): () => ChangedFiles {
  const before = dirs.map(({ dir }) => snapshot(dir));
  return () =>
    dirs.reduce<ChangedFiles>(
      (all, { dir, prefix }, index) => {
        const one = diffSnapshots(
          before[index] ?? (new Map() as Snapshot),
          snapshot(dir),
        );
        const under = (files: string[]): string[] =>
          files.map((file) => (prefix ? `${prefix}/${file}` : file));
        return mergeChanges(all, {
          created: under(one.created),
          modified: under(one.modified),
          deleted: under(one.deleted),
        });
      },
      { created: [], modified: [], deleted: [] },
    );
}
