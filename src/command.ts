import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "./exec.js";
import { messageOf, tempDir } from "./scope.js";

/** Where a command check runs, and what it may read. */
export interface CommandContext {
  /** The agent's workspace as the agent left it. The command's working directory. */
  workspace: string;
  /** A copy of the case's `grader/` directory made after the agent exited; null when the case has none. */
  graderDir: string | null;
  /** A read-only copy of the workspace as it was before the agent ran; null when none was taken. */
  seedDir: string | null;
  /** The run's throwaway home. */
  home: string;
  /** The absolute path of the run's transcript file, written before any check runs. Null when none was written. */
  transcriptFile: string | null;
  /** The run's per-run directory outside the workspace, for bare remotes and linked worktrees; null when none was made. */
  remoteDir: string | null;
  /** What the case sets in its `env`, which the command gets too. */
  env: Record<string, string>;
}

/**
 * Makes the context of the command checks of one run.
 * @param ran - What the session left, while its directories still exist.
 * @param ran.workspace - The agent's workspace.
 * @param ran.home - The run's throwaway home.
 * @param ran.seedDir - The copy of the workspace taken before the agent ran; null when none was taken.
 * @param ran.graderDir - The copy of the case's `grader/` directory; null when the case has none.
 * @param ran.remoteDir - The run's remote directory; null when none was made.
 * @param env - The case's `env`.
 * @param transcriptFile - The absolute path of the run's transcript file; null when none was written.
 * @returns The context, with the transcript's path as `transcriptFile`.
 */
export function commandContext(
  ran: Pick<
    CommandContext,
    "workspace" | "home" | "graderDir" | "seedDir" | "remoteDir"
  >,
  env: Record<string, string>,
  transcriptFile: string | null = null,
): CommandContext {
  return {
    workspace: ran.workspace,
    graderDir: ran.graderDir,
    seedDir: ran.seedDir,
    home: ran.home,
    transcriptFile,
    remoteDir: ran.remoteDir,
    env,
  };
}

/** What one command did. */
export interface CommandResult {
  /** The exit code; null when a signal ended the command, or when it never started. */
  exit: number | null;
  stdout: string;
  /** For a command that never started, the reason. At most 5 MB is kept. */
  stderr: string;
  /** The signal that ended the command, when one did. */
  signal: string | null;
  /** True when a stream came out longer than 5 MB and the end was dropped. */
  truncated: boolean;
  durationMs: number;
  /** "timeout": the time ran out and the process group was killed. "spawn": the shell could not be started. */
  failure: "timeout" | "spawn" | null;
}

// The most of each stream that is kept: a command that prints more is cut, and the check says so.
const BYTES_PER_MEGABYTE = 1_048_576;
const KEPT_MEGABYTES = 5;
const KEPT_BYTES = KEPT_MEGABYTES * BYTES_PER_MEGABYTE;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const FIXTURE = "fixture";
const FIXTURE_EMAIL = "fixture@example.invalid";

/**
 * Builds the environment of a command, and of a setup step: the listed names, the case's own `env`, and nothing of this
 * process's environment besides `PATH`, `TMPDIR` and `LANG`. No provider key is among them, and git reads no
 * configuration of the user's.
 * @param context - Where the command runs.
 * @returns The whole environment.
 */
export function commandEnv(context: CommandContext): Record<string, string> {
  const optional = {
    SKILL_EVALS_GRADER_DIR: context.graderDir,
    SKILL_EVALS_SEED_DIR: context.seedDir,
    SKILL_EVALS_TRANSCRIPT: context.transcriptFile,
    SKILL_EVALS_REMOTE_DIR: context.remoteDir,
  };
  return {
    PATH: process.env["PATH"] ?? DEFAULT_PATH,
    HOME: context.home,
    TMPDIR: process.env["TMPDIR"] ?? os.tmpdir(),
    LANG: process.env["LANG"] ?? "C.UTF-8",
    SKILL_EVALS_WORKSPACE: context.workspace,
    SKILL_EVALS_HOME: context.home,
    ...Object.fromEntries(
      Object.entries(optional).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    ),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    // Git neither refreshes the index of a read-only seed (as root it could) nor looks for a repository above the
    // workspace's parent directory.
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CEILING_DIRECTORIES: path.dirname(context.workspace),
    GIT_AUTHOR_NAME: FIXTURE,
    GIT_COMMITTER_NAME: FIXTURE,
    GIT_AUTHOR_EMAIL: FIXTURE_EMAIL,
    GIT_COMMITTER_EMAIL: FIXTURE_EMAIL,
    ...context.env,
  };
}

/**
 * Runs one command of a command check, as the invoking user and without a sandbox.
 * @param command - Shell text, run with `/bin/sh -c` in the workspace, in its own process group.
 * @param context - The directories it may use.
 * @param timeoutSeconds - How long it may run before its whole process group is killed.
 * @returns What it did. It never rejects: a timeout and a start that failed are in `failure`.
 */
export async function runCommand(
  command: string,
  context: CommandContext,
  timeoutSeconds: number,
): Promise<CommandResult> {
  const started = Date.now();
  const result = await exec("/bin/sh", ["-c", command], {
    cwd: context.workspace,
    env: commandEnv(context),
    timeoutSeconds,
    reapOnExit: true,
    maxBytes: KEPT_BYTES,
  });
  return {
    exit: result.exit,
    stdout: result.stdout,
    stderr: result.kind === "spawn" ? (result.failure ?? "") : result.stderr,
    signal: result.signal,
    truncated: result.truncated,
    durationMs: Date.now() - started,
    failure: result.kind,
  };
}

/** The directories a session makes for command checks. */
export interface CommandCopies {
  /** A read-only copy of the workspace as the copy of the case left it. */
  seedDir: string;
  /** Copies the held-out directory into a temp directory; null when the case has none. Call it after the agent exits. */
  copyGrader: () => string | null;
  /** Removes both copies. */
  dispose: () => void;
}

// A neutral name: the agent may list the temp directory while it runs, and a name like "grader" would tell it what
// the directory is for.
const COPY_PREFIX = "copy-";
const WRITE_BITS = 0o222;
const OWNER_WRITE = 0o200;
const PERMISSION_BITS = 0o7777;

/**
 * Switches the write permission of every file and directory of a tree, best effort: a link is left alone, execute
 * bits stay, and a user who may write anyway (root) is not stopped. The seed snapshot is what catches a change.
 * @param dir - The tree.
 * @param writable - True to let the owner write again, so that the tree can be removed.
 */
export function setWritable(dir: string, writable: boolean): void {
  const change = (entry: string): void => {
    const mode = fs.lstatSync(entry).mode & PERMISSION_BITS;
    fs.chmodSync(entry, writable ? mode | OWNER_WRITE : mode & ~WRITE_BITS);
  };
  try {
    // A directory must be writable before its entries can change, and is locked last.
    if (writable) change(dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) setWritable(full, writable);
      else if (entry.isFile()) change(full);
    }
    if (!writable) change(dir);
  } catch {
    // Best effort.
  }
}

/**
 * Takes the copies that command checks read.
 * @param workspace - The workspace, just after the case's files were copied in and before the agent ran.
 * @param graderDir - The case's `grader/` directory, or null. It is not read until `copyGrader` is called.
 * @returns The seed directory, a function that copies the grader directory later, and a `dispose` for both.
 */
export function copiesForCommands(
  workspace: string,
  graderDir: string | null,
): CommandCopies {
  // The seed copy removes itself with its own cleanup, which restores the write bits first, also at process exit.
  const seed = tempDir(COPY_PREFIX, (dir) => {
    setWritable(dir, true);
  });
  try {
    fs.cpSync(workspace, seed.dir, { recursive: true, verbatimSymlinks: true });
  } catch (error) {
    seed.dispose();
    throw error;
  }
  setWritable(seed.dir, false);
  let grader: ReturnType<typeof tempDir> | null = null;
  return {
    seedDir: seed.dir,
    copyGrader: () => {
      if (graderDir === null) return null;
      grader = tempDir(COPY_PREFIX);
      fs.cpSync(graderDir, grader.dir, {
        recursive: true,
        verbatimSymlinks: true,
      });
      return grader.dir;
    },
    dispose: () => {
      seed.dispose();
      grader?.dispose();
    },
  };
}

/**
 * Removes the harness's login files from the throwaway home, so that a command cannot read them through `$HOME`.
 * @param authFiles - The adapter's login files, relative to a home directory.
 * @param home - The run's throwaway home.
 * @returns Why a file could not be removed, or null when none is left.
 */
export function removeLogin(authFiles: string[], home: string): string | null {
  try {
    for (const relative of authFiles) {
      fs.rmSync(path.join(home, relative), { recursive: true, force: true });
    }
    return null;
  } catch (error) {
    return messageOf(error);
  }
}
