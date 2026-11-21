import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { globToRegExp } from "./glob.js";
import { UsageError, tempDir } from "./scope.js";
import type { ChangedFiles } from "./snapshot.js";
import { diffSnapshots, snapshot } from "./snapshot.js";

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

/**
 * Removes what an export leaves out from a tree that was extracted whole.
 * @param root - The tree.
 * @param left - Tells a relative posix path that goes.
 */
function prune(root: string, left: (relative: string) => boolean): void {
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      const file = path.join(dir, entry.name);
      if (left(relative)) fs.rmSync(file, { recursive: true, force: true });
      else if (entry.isDirectory()) walk(file, `${relative}/`);
    }
  };
  walk(root, "");
}

/**
 * Makes sure that no link of a tree leads out of it. A link that is absolute would reach the source directory from
 * a copy, so it counts as outside, too.
 * @param root - The tree.
 * @throws {UsageError} Naming the first link whose target is absolute, or is relative and leaves the tree.
 */
function requireLinksInside(root: string): void {
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file, `${relative}/`);
      } else if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        const leaves = path.relative(root, path.resolve(dir, target));
        if (
          path.isAbsolute(target) ||
          leaves === ".." ||
          leaves.startsWith(`..${path.sep}`)
        ) {
          throw new UsageError(
            `${relative} is a link to ${target}${path.isAbsolute(target) ? ", an absolute path" : ""}; links outside the subject are not allowed`,
          );
        }
      }
    }
  };
  walk(root, "");
}

/** Where a subject's files are. */
interface Source {
  /** The directory to copy; for a commit, the repository, which the commit is looked up in. */
  dir: string;
  /** The full hash of the commit to export, or null to copy `dir` as it is on disk. */
  commit: string | null;
  repoRoot: string;
}

/**
 * Exports a subject to a temp directory, so that nothing loads from the source in place.
 * A directory is copied, with links kept as links. A commit is written with `git archive` and `tar`, which honours
 * `export-ignore`.
 * @param source - What to export.
 * @param exclude - Globs, relative to the root of the subject, of what to leave out besides `.git` and `node_modules`.
 * @returns The export's directory, and a `dispose` that removes it; it also runs at process exit.
 * @throws {UsageError} When `git` or `tar` is missing, or a link of the subject leads outside it.
 */
export function exportSubject(
  source: Source,
  exclude: string[],
): { dir: string; dispose: () => void } {
  const left = leaveOut(exclude);
  const out = tempDir("kit-");
  try {
    if (source.commit) {
      extractCommit(source.repoRoot, source.commit, out.dir);
      prune(out.dir, left);
    } else {
      fs.cpSync(source.dir, out.dir, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (file) => {
          const relative = path
            .relative(source.dir, file)
            .split(path.sep)
            .join("/");
          return relative === "" || !left(relative);
        },
      });
    }
    requireLinksInside(out.dir);
  } catch (error) {
    out.dispose();
    throw error;
  }
  return out;
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
