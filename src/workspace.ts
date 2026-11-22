import fs from "node:fs";
import path from "node:path";
import type { Case } from "./cases.js";
import type { CommandCopies } from "./command.js";
import { commandEnv, copiesForCommands } from "./command.js";
import { exec } from "./exec.js";
import { tempDir } from "./scope.js";
import { DEFAULT_STEP_SECONDS, stepCommand } from "./setup-steps.js";
import type { Snapshot } from "./snapshot.js";
import { snapshot } from "./snapshot.js";
import { walkTree } from "./walk.js";

/** What a case contributes to the workspace and its setup. */
export type Layers = Pick<
  Case,
  | "workspaceDir"
  | "fixtureDirs"
  | "fixtureDir"
  | "homeDir"
  | "setup"
  | "graderDir"
  | "env"
  | "checks"
>;

/** A workspace that is ready for the agent, or the reason it is not. */
export interface PreparedRun {
  /** The workspace as the agent starts from it, setup included. */
  seed: Snapshot;
  /** The copies that command checks read; null when the case has no `command` check. */
  copies: CommandCopies | null;
  /** The read-only copy of the seed; null when the case has no `command` check. */
  seedDir: string | null;
  /** The run's directory outside the workspace, for bare remotes and linked worktrees. It lives until `dispose`. */
  remoteDir: string;
  /** `setup failed: step <n> (<first words>): <why>` for the first step that failed; null when all worked. */
  failure: string | null;
  /** Removes the remote directory and the copies. */
  dispose: () => void;
}

// Neutral names: the agent can list the temp directory and read the path of its remote.
const REMOTE_PREFIX = "store-";
const FIXTURE_PREFIX = "assets-";
const SHOWN_COMMAND_LENGTH = 40;
// What setup commits as unless the case's `env` says otherwise: nothing in the history names the tool.
const NEUTRAL_IDENTITY = {
  GIT_AUTHOR_NAME: "Developer",
  GIT_COMMITTER_NAME: "Developer",
  GIT_AUTHOR_EMAIL: "developer@example.com",
  GIT_COMMITTER_EMAIL: "developer@example.com",
};

/**
 * Copies a directory's content into another, keeping links as they are; a file that exists is overwritten.
 * @param from - The source directory.
 * @param to - The target directory, which exists.
 */
function copyTree(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

/**
 * Runs the setup steps in the workspace, in order, until one fails.
 * @param steps - The case's `setup`.
 * @param where - Where they run and what they get.
 * @param where.workspace - The working directory.
 * @param where.env - The environment.
 * @returns The failure text of the first step that failed; null when every step worked.
 */
async function runSteps(
  steps: Layers["setup"],
  where: { workspace: string; env: Record<string, string> },
): Promise<string | null> {
  for (const [index, step] of steps.entries()) {
    const command = stepCommand(step);
    const timeoutSeconds =
      ("run" in step ? step.timeoutSeconds : undefined) ?? DEFAULT_STEP_SECONDS;
    const { failure } = await exec("/bin/sh", ["-c", command], {
      cwd: where.workspace,
      env: where.env,
      timeoutSeconds,
      reapOnExit: true,
    });
    if (failure) {
      const shown = command
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, SHOWN_COMMAND_LENGTH);
      return `setup failed: step ${String(index + 1)} (${shown}): ${failure}`;
    }
  }
  return null;
}

/**
 * Builds the workspace the agent starts from: the shared fixtures in order, then the case's `workspace/`, then the
 * setup steps. The case's `fixture/` directory is copied to a temp directory outside the workspace and exposed to the
 * steps only, so that a `git` step cannot record it, and removed when they are done.
 * @param caseDef - What the case holds.
 * @param dirs - The run's empty workspace and its throwaway home.
 * @param dirs.workspace - The directory the case's files are copied into and the steps run in.
 * @param dirs.home - The home, which the steps get as `HOME`.
 * @returns The seed, the copies for command checks, the remote directory, and why setup failed if it did. The caller
 *   calls `dispose` when the run's checks are done.
 * @throws {Error} When a file cannot be copied; the remote directory is removed first.
 */
export async function prepareRun(
  caseDef: Layers,
  dirs: { workspace: string; home: string },
): Promise<PreparedRun> {
  const remote = tempDir(REMOTE_PREFIX);
  const fixture = caseDef.fixtureDir
    ? { source: caseDef.fixtureDir, ...tempDir(FIXTURE_PREFIX) }
    : null;
  let copies: CommandCopies | null = null;
  try {
    for (const layer of [...caseDef.fixtureDirs, caseDef.workspaceDir]) {
      if (layer) copyTree(layer, dirs.workspace);
    }
    if (fixture) copyTree(fixture.source, fixture.dir);
    const env = commandEnv({
      workspace: dirs.workspace,
      home: dirs.home,
      graderDir: null,
      seedDir: null,
      transcriptFile: null,
      remoteDir: remote.dir,
      env: {
        ...NEUTRAL_IDENTITY,
        ...caseDef.env,
        ...(fixture && { SKILL_EVALS_FIXTURE_DIR: fixture.dir }),
      },
    });
    const failure = await runSteps(caseDef.setup, {
      workspace: dirs.workspace,
      env,
    });
    fixture?.dispose();
    const wantsCopies =
      failure === null && caseDef.checks.some((one) => one.type === "command");
    copies = wantsCopies
      ? copiesForCommands(dirs.workspace, caseDef.graderDir)
      : null;
    return {
      seed: snapshot(dirs.workspace),
      copies,
      seedDir: copies?.seedDir ?? null,
      remoteDir: remote.dir,
      failure,
      dispose: () => {
        copies?.dispose();
        remote.dispose();
      },
    };
  } catch (error) {
    fixture?.dispose();
    copies?.dispose();
    remote.dispose();
    throw error;
  }
}

/**
 * Copies a case's `home` directory into the run's throwaway home. A file of it never replaces one that is there: the
 * login files, the skills the adapter placed and what the harness's setup wrote are not the case's to change.
 * @param homeDir - The case's `home` directory; null when it has none.
 * @param home - The run's throwaway home.
 * @returns `home/ would replace <path>` for the first file that would; null after a copy.
 */
export function copyHome(homeDir: string | null, home: string): string | null {
  if (!homeDir) return null;
  const clashes: string[] = [];
  walkTree(homeDir, {
    visit: ({ relative, dirent }) => {
      const taken = fs.existsSync(path.join(home, relative));
      if (taken && !dirent.isDirectory()) clashes.push(relative);
      return undefined;
    },
  });
  const [clash] = clashes;
  if (clash) return `home/ would replace ${clash}`;
  copyTree(homeDir, home);
  return null;
}
