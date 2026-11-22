import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findOnPath } from "./capabilities.js";
import { setWritable } from "./command.js";
import { UsageError, tempDir } from "./scope.js";
import type { Snapshot } from "./snapshot.js";

/** What a run's files are archived under: `<stem>` and this. */
export const ARCHIVE_SUFFIX = ".workspace.tar";
// The top-level names of an archive. They never show a temp directory's name.
const WORKSPACE = "workspace";
const SEED = "seed";
const REMOTES = "remotes";
const HOME = "home";
// The hashes of the home as the harness's prompt found it, which the home alone cannot give back.
const HOME_SEED = "home-seed.json";
// A login file shorter than this is not told by its content.
const MIN_SECRET_BYTES = 32;
const STAGE_PREFIX = "stage-";
const UNPACK_PREFIX = "unpack-";

/** What one run leaves, as `archiveRun` reads it. */
export interface Archivable {
  workspace: string;
  /** The copy of the workspace as the agent started from it; null when none was made. */
  seedDir: string | null;
  /** The run's directory for bare remotes and linked worktrees; null when none was made. */
  remoteDir: string | null;
  home: string;
  /** The hashes of the home just before the harness's prompt ran. */
  homeSeed: Snapshot;
  /** The harness's login files, relative to the home. They never go into an archive. */
  authFiles: string[];
}

/** A run's files, unpacked at the layout of the run. */
export interface Unpacked {
  workspace: string;
  /** The seed copy, read-only; null when the archive has none. */
  seedDir: string | null;
  remoteDir: string | null;
  home: string;
  /** The home as the prompt found it, without the login files; empty when the archive says nothing of it. */
  homeSeed: Snapshot;
  dispose: () => void;
}

/**
 * Checks that the system `tar` is there.
 * @param env - Where `PATH` is read from. Default: the process's.
 * @throws {UsageError} When no `tar` is on `PATH`.
 */
export function requireTar(
  env: Record<string, string | undefined> = process.env,
): void {
  if (findOnPath("tar", env) === null) {
    throw new UsageError(
      "--keep-workspaces needs the system tar, and there is none on PATH",
    );
  }
}

/** What must not be copied into an archive: the login files by path, and any file with their content. */
interface Banned {
  /** Receives the archive path of each file left out because it holds a login file's content. */
  omitted: string[];
  /** The home directory that `paths` are relative to, when the directory being copied is the home. */
  home?: string;
  /** The login files' paths, relative to the home. */
  paths: string[];
  /** The sha256 of each login file's content, by its size in bytes. */
  hashes: Map<number, Set<string>>;
}

/**
 * Hashes the login files that exist, in the user's home and in the run's home.
 * @param authFiles - The login files, relative to a home.
 * @param homes - The directories that may hold them.
 * @returns The content hashes of the regular files found, by size.
 */
function loginHashes(
  authFiles: string[],
  homes: string[],
): Map<number, Set<string>> {
  const found = new Map<number, Set<string>>();
  for (const home of homes) {
    for (const relative of authFiles) {
      const file = path.join(home, relative);
      try {
        if (!fs.lstatSync(file).isFile()) continue;
        const content = fs.readFileSync(file);
        // A short or generic file, such as `{}`, says nothing about a login: ordinary files hold the same.
        if (content.length < MIN_SECRET_BYTES) continue;
        const sums = found.get(content.length) ?? new Set<string>();
        sums.add(createHash("sha256").update(content).digest("hex"));
        found.set(content.length, sums);
      } catch {
        // A login file that is not there has nothing to leave out.
      }
    }
  }
  return found;
}

/**
 * Tells whether a file has the content of a login file.
 * @param file - A path.
 * @param hashes - The content hashes of the login files, by size.
 * @returns True for a regular file of the same size and hash.
 */
function holdsLogin(file: string, hashes: Map<number, Set<string>>): boolean {
  try {
    const info = fs.lstatSync(file);
    const sums = info.isFile() ? hashes.get(info.size) : undefined;
    return (
      sums !== undefined &&
      sums.has(createHash("sha256").update(fs.readFileSync(file)).digest("hex"))
    );
  } catch {
    return false;
  }
}

/**
 * Copies a directory into the staging area under a fixed name, leaving out what is banned; a directory that is gone
 * becomes an empty one. Nothing is deleted afterwards, so no link can lead a removal out of the copy.
 * @param from - The directory, or null.
 * @param to - The target.
 * @param banned - What to leave out. Its paths apply when it names the `home` that `from` is.
 */
function stage(from: string | null, to: string, banned: Banned): void {
  if (from === null || !fs.existsSync(from)) {
    fs.mkdirSync(to);
    return;
  }
  fs.cpSync(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      if (
        banned.home !== undefined &&
        isLogin(path.relative(banned.home, source), banned.paths)
      ) {
        return false;
      }
      if (!holdsLogin(source, banned.hashes)) return true;
      banned.omitted.push(
        path.posix.join(
          path.basename(to),
          path.relative(from, source).split(path.sep).join("/"),
        ),
      );
      return false;
    },
  });
}

/**
 * Tells whether a path of the home is, or is under, a login file.
 * @param relative - A path relative to the home.
 * @param authFiles - The harness's login files, relative to the home.
 * @returns True when it is one of them or lies inside one.
 */
const isLogin = (relative: string, authFiles: string[]): boolean =>
  authFiles.some(
    (file) => relative === file || relative.startsWith(`${file}/`),
  );

/** A run's files copied under their fixed names, ready for `tar`. */
export interface Staged {
  dir: string;
  names: string[];
  /** The archive paths of the files left out because they hold a login file's content. */
  omitted: string[];
  dispose: () => void;
}

/**
 * Copies a run's workspace, seed, remotes and home under fixed names, and writes the home seed, leaving out the
 * harness's login files and any file that has their content. Nothing is removed from a copy, so a link in the home cannot
 * lead a removal anywhere. The grader's copy is never given to this function, so it cannot be staged.
 * @param source - What the run left, while it still exists.
 * @returns The staging directory, the names to archive, and a `dispose`.
 * @throws {Error} When a file cannot be copied; nothing is left staged.
 */
export function stageRun(source: Archivable): Staged {
  const area = tempDir(STAGE_PREFIX, (dir) => {
    setWritable(dir, true);
  });
  try {
    const banned: Banned = {
      omitted: [],
      paths: source.authFiles,
      hashes: loginHashes(source.authFiles, [os.homedir(), source.home]),
    };
    stage(source.workspace, path.join(area.dir, WORKSPACE), banned);
    stage(source.home, path.join(area.dir, HOME), {
      ...banned,
      home: source.home,
    });
    const names = [WORKSPACE, HOME, HOME_SEED];
    if (source.seedDir !== null) {
      stage(source.seedDir, path.join(area.dir, SEED), banned);
      names.push(SEED);
    }
    if (source.remoteDir !== null) {
      stage(source.remoteDir, path.join(area.dir, REMOTES), banned);
      names.push(REMOTES);
    }
    const kept = [...source.homeSeed].filter(
      ([relative, hash]) =>
        !isLogin(relative, source.authFiles) &&
        ![...banned.hashes.values()].some((sums) => sums.has(hash)),
    );
    fs.writeFileSync(
      path.join(area.dir, HOME_SEED),
      JSON.stringify(Object.fromEntries(kept)),
    );
    setWritable(area.dir, true);
    return {
      dir: area.dir,
      names,
      omitted: banned.omitted,
      dispose: area.dispose,
    };
  } catch (error) {
    area.dispose();
    throw error;
  }
}

/**
 * Writes staged files to an archive with the system `tar`, and removes the staging area.
 * @param staged - What `stageRun` made.
 * @param target - The archive's path; its directory exists.
 * @returns The size of the archive in bytes.
 * @throws {Error} When `tar` fails; nothing is left at `target`.
 */
export function writeArchive(staged: Staged, target: string): number {
  try {
    const partial = `${target}.partial`;
    execFileSync("tar", ["-cf", partial, "-C", staged.dir, ...staged.names], {
      stdio: "ignore",
    });
    fs.renameSync(partial, target);
    return fs.statSync(target).size;
  } finally {
    staged.dispose();
  }
}

/**
 * Archives a run's files in one step: `stageRun`, then `writeArchive`.
 * @param source - What the run left, while it still exists.
 * @param target - The archive's path; its directory exists.
 * @returns The size of the archive in bytes.
 * @throws {Error} When a file cannot be copied or `tar` fails.
 */
export const archiveRun = (source: Archivable, target: string): number =>
  writeArchive(stageRun(source), target);

/**
 * Unpacks an archive of `archiveRun` into a temp directory, at the layout of the run.
 * @param file - The path of an archive that `archiveRun` made.
 * @returns The directories, and a `dispose` that removes them.
 * @throws {Error} When the archive cannot be read or unpacked.
 */
export function unpackArchive(file: string): Unpacked {
  const area = tempDir(UNPACK_PREFIX, (dir) => {
    setWritable(dir, true);
  });
  try {
    execFileSync(
      "tar",
      ["-xf", file, "-C", area.dir, "--no-same-owner", "--no-same-permissions"],
      { stdio: "ignore" },
    );
    const at = (name: string): string => path.join(area.dir, name);
    const seedDir = fs.existsSync(at(SEED)) ? at(SEED) : null;
    // The seed is read-only again, as a command check finds it in a run.
    if (seedDir !== null) setWritable(seedDir, false);
    const seeded = fs.existsSync(at(HOME_SEED))
      ? (JSON.parse(fs.readFileSync(at(HOME_SEED), "utf8")) as Record<
          string,
          string
        >)
      : {};
    return {
      workspace: at(WORKSPACE),
      seedDir,
      remoteDir: fs.existsSync(at(REMOTES)) ? at(REMOTES) : null,
      home: at(HOME),
      homeSeed: new Map(Object.entries(seeded)),
      dispose: area.dispose,
    };
  } catch (error) {
    area.dispose();
    throw error;
  }
}
