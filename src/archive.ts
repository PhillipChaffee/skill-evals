import { execFileSync } from "node:child_process";
import fs from "node:fs";
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

/**
 * Copies a directory into the staging area under a fixed name; a directory that is gone becomes an empty one.
 * @param from - The directory, or null.
 * @param to - The target.
 */
function stage(from: string | null, to: string): void {
  if (from !== null && fs.existsSync(from)) {
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  } else {
    fs.mkdirSync(to);
  }
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

/**
 * Archives a run's workspace, seed, remotes and home with the system `tar`, under fixed names, without the harness's
 * login files. The grader's copy is never given to this function, so it cannot be in the archive.
 * @param source - What the run left, while it still exists.
 * @param target - The archive's path; its directory exists.
 * @returns The size of the archive in bytes.
 * @throws {Error} When a file cannot be copied or `tar` fails; nothing is left at `target`.
 */
export function archiveRun(source: Archivable, target: string): number {
  const area = tempDir(STAGE_PREFIX, (dir) => {
    setWritable(dir, true);
  });
  try {
    stage(source.workspace, path.join(area.dir, WORKSPACE));
    stage(source.home, path.join(area.dir, HOME));
    for (const file of source.authFiles) {
      fs.rmSync(path.join(area.dir, HOME, file), {
        recursive: true,
        force: true,
      });
    }
    const names = [WORKSPACE, HOME, HOME_SEED];
    if (source.seedDir !== null) {
      stage(source.seedDir, path.join(area.dir, SEED));
      names.push(SEED);
    }
    if (source.remoteDir !== null) {
      stage(source.remoteDir, path.join(area.dir, REMOTES));
      names.push(REMOTES);
    }
    const kept = [...source.homeSeed].filter(
      ([relative]) => !isLogin(relative, source.authFiles),
    );
    fs.writeFileSync(
      path.join(area.dir, HOME_SEED),
      JSON.stringify(Object.fromEntries(kept)),
    );
    setWritable(area.dir, true);
    const partial = `${target}.partial`;
    execFileSync("tar", ["-cf", partial, "-C", area.dir, ...names], {
      stdio: "ignore",
    });
    fs.renameSync(partial, target);
    return fs.statSync(target).size;
  } finally {
    area.dispose();
  }
}

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
    execFileSync("tar", ["-xf", file, "-C", area.dir], { stdio: "ignore" });
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
