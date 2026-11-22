import fs from "node:fs";
import os from "node:os";
import { exec } from "./exec.js";
import { tempDir } from "./scope.js";

/** Where a command check runs, and what it may read. */
export interface CommandContext {
  /** The agent's workspace as the agent left it. The command's working directory. */
  workspace: string;
  /** A copy of the case's `grader/` directory made after the agent exited; null when the case has none. */
  graderDir: string | null;
  /** The workspace as it was before the agent ran. */
  seedDir: string;
  /** The run's throwaway home. */
  home: string;
  /** The run's transcript file. Null until the transcript is written (Task 14). */
  transcriptFile: string | null;
  /** The directory of the run's local remote. Null until fixtures exist (Task 13). */
  remoteDir: string | null;
  /** What the case sets in its `env`, which the command gets too. */
  env: Record<string, string>;
}

/**
 * Makes the context of the command checks of one run.
 * @param ran - What the session left, while its directories still exist.
 * @param ran.workspace - The agent's workspace.
 * @param ran.home - The run's throwaway home.
 * @param ran.seedDir - The copy of the workspace taken before the agent ran; null when the case has no command check.
 * @param ran.graderDir - The copy of the case's `grader/` directory; null when the case has none.
 * @param env - The case's `env`.
 * @returns The context. The transcript and the remote directory are null until later tasks make them.
 */
export function commandContext(
  ran: Pick<CommandContext, "workspace" | "home" | "graderDir"> & {
    seedDir: string | null;
  },
  env: Record<string, string>,
): CommandContext {
  return {
    workspace: ran.workspace,
    graderDir: ran.graderDir,
    seedDir: ran.seedDir ?? "",
    home: ran.home,
    transcriptFile: null,
    remoteDir: null,
    env,
  };
}

/** What one command did. */
export interface CommandResult {
  /** The exit code; null when a signal ended the command, or when it never started. */
  exit: number | null;
  stdout: string;
  /** For a command that never started, the reason. */
  stderr: string;
  durationMs: number;
  /** "timeout": the time ran out and the process group was killed. "spawn": the shell could not be started. */
  failure: "timeout" | "spawn" | null;
}

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const FIXTURE = "fixture";
const FIXTURE_EMAIL = "fixture@example.invalid";

/**
 * Builds the environment of a command: the listed names, the case's own `env`, and nothing of this process's
 * environment besides `PATH`, `TMPDIR` and `LANG`. No provider key is among them.
 * @param context - Where the command runs.
 * @returns The whole environment.
 */
function commandEnv(context: CommandContext): Record<string, string> {
  const optional = {
    SKILL_EVALS_GRADER_DIR: context.graderDir,
    SKILL_EVALS_TRANSCRIPT: context.transcriptFile,
    SKILL_EVALS_REMOTE_DIR: context.remoteDir,
  };
  return {
    PATH: process.env["PATH"] ?? DEFAULT_PATH,
    HOME: context.home,
    TMPDIR: process.env["TMPDIR"] ?? os.tmpdir(),
    LANG: process.env["LANG"] ?? "C.UTF-8",
    SKILL_EVALS_WORKSPACE: context.workspace,
    SKILL_EVALS_SEED_DIR: context.seedDir,
    SKILL_EVALS_HOME: context.home,
    ...Object.fromEntries(
      Object.entries(optional).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    ),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
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
  });
  return {
    exit: result.exit,
    stdout: result.stdout,
    stderr: result.kind === "spawn" ? (result.failure ?? "") : result.stderr,
    durationMs: Date.now() - started,
    failure: result.kind,
  };
}

/** The directories a session makes for command checks. */
export interface CommandCopies {
  /** A copy of the workspace as the copy of the case left it. */
  seedDir: string;
  /** Copies the held-out directory into a temp directory; null when the case has none. Call it after the agent exits. */
  copyGrader: () => string | null;
  /** Removes both copies. */
  dispose: () => void;
}

// A neutral name: the agent may list the temp directory while it runs, and a name like "grader" would tell it what
// the directory is for.
const COPY_PREFIX = "copy-";

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
  const seed = tempDir(COPY_PREFIX);
  fs.cpSync(workspace, seed.dir, { recursive: true, verbatimSymlinks: true });
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
