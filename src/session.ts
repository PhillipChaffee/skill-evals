import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchCanaries } from "./canaries.js";
import { tempDir } from "./scope.js";
import type { RunEnd } from "./session-end.js";
import { endOf } from "./session-end.js";
import {
  attempt,
  inputOf,
  notStarted,
  parseStream,
} from "./session-attempt.js";
import type { Dirs, SessionInput, SessionResult } from "./session-attempt.js";
import type { Seeded } from "./history-plant.js";
import { UNSEEDED, plantHistory } from "./history-plant.js";
import type { RulesInstalled } from "./rules-install.js";
import { installRulesFor } from "./rules-install.js";
import type { McpStarted, MockLogRead } from "./mcp/stage.js";
import { startMcp, withMockLog } from "./mcp/stage.js";
import type { Snapshot } from "./snapshot.js";
import { snapshot } from "./snapshot.js";
import { runTurns } from "./turns.js";
import type { PreparedRun } from "./workspace.js";
import { prepareRun } from "./workspace.js";

export type { SessionInput, SessionResult } from "./session-attempt.js";

// Login files hold secrets, so only the owner may read the copies.
const OWNER_READ_WRITE = 0o600;

/**
 * Gives the harness its login in the throwaway home.
 * @param authFiles - Paths relative to a home directory; one that the user's home lacks is skipped.
 * @param home - The throwaway home.
 */
function copyAuthFiles(authFiles: string[], home: string): void {
  for (const relative of authFiles) {
    const source = path.join(os.homedir(), relative);
    if (!fs.existsSync(source)) continue;
    const target = path.join(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, OWNER_READ_WRITE);
  }
}

/**
 * Builds the workspace the case describes. Setup runs before the login files are in the home, so no step can read them.
 * @param run - The case's layers, and whether the run is kept.
 * @param dirs - The run's empty workspace and throwaway home.
 * @param dirs.workspace - The directory that the case's files are copied into.
 * @param dirs.home - The throwaway home that the setup steps get as `HOME`.
 * @returns The prepared run; null when the session has no case.
 */
const prepareOf = (
  run: SessionInput,
  dirs: { workspace: string; home: string },
): Promise<PreparedRun | null> =>
  run.layers
    ? prepareRun(run.layers, dirs, { keepSeed: run.keepSeed ?? false })
    : Promise.resolve(null);

/** What a session made of its prompt or its turns, before the workspace is read. */
type Done = Pick<
  SessionResult,
  | "stdout"
  | "durationMs"
  | "placedChanges"
  | "placed"
  | "homeSeed"
  | "turns"
  | "firstOutputMs"
  | "ending"
  | "userTurns"
  | "turnChanges"
> & { end: RunEnd };

/**
 * Runs the harness once for the case's single prompt.
 * @param run - The harness, the prompt, and what to load.
 * @param where - The run's directories, a failed setup step if one stopped the case, and what was planted.
 * @param where.dirs - Where the run is.
 * @param where.failure - Why the harness never starts; null when it does.
 * @param where.seeded - What planting the case's history left.
 * @returns What the process left, and how it ended.
 */
async function single(
  run: SessionInput,
  where: { dirs: Dirs; failure: string | null; seeded: Seeded },
): Promise<Done> {
  const { home } = where.dirs;
  const ran =
    where.failure === null
      ? await attempt(run, inputOf(run, where))
      : notStarted(where.failure, home);
  const end = endOf({
    ...ran,
    parsed: parseStream(run.harness, ran.stdout),
    onTimeout: run.onTimeout,
  });
  return {
    ...ran,
    placed: ran.placed,
    end,
    ending: {
      error: end.error,
      stoppedBy: end.stoppedBy,
      agentEvents: end.parsed.transcript.length,
      unfinished: end.parsed.unfinished === true,
      fault: ran.fault,
      exec: ran.exec,
    },
    userTurns: null,
    turnChanges: null,
  };
}

/** What `resultOf` makes a session result from. */
interface Made {
  seeded: Seeded;
  done: Done;
  /** The run's stream, and what the mock log said of it. */
  read: MockLogRead;
  dirs: Dirs;
  seed: Snapshot;
  prepared: PreparedRun | null;
  graderDir: string | null;
  rules: RulesInstalled | null;
  canaryChanges: string[] | null;
}

/**
 * Gathers what a finished session produced.
 * @param run - The session's input.
 * @param made - The parts the session made.
 * @returns The result, which `session` hands to its callback while the directories still exist.
 */
function resultOf(run: SessionInput, made: Made): SessionResult {
  const { done, dirs, prepared } = made;
  return {
    seeded: made.seeded.history,
    stdout: done.stdout,
    parsed: made.read.parsed,
    error: done.end.error,
    durationMs: done.durationMs,
    stoppedBy: done.end.stoppedBy,
    turns: done.turns,
    firstOutputMs: done.firstOutputMs,
    ending: done.ending,
    userTurns: done.userTurns,
    turnChanges: done.turnChanges,
    workspace: dirs.workspace,
    seed: made.seed,
    placedChanges: done.placedChanges,
    home: dirs.home,
    homeSeed: done.homeSeed,
    placed: done.placed,
    seedDir: prepared?.seedDir ?? null,
    remoteDir: prepared?.remoteDir ?? null,
    graderDir: made.graderDir,
    rulesInstalled: run.rules ? (made.rules?.installed ?? []) : null,
    mcpServers: run.mcp?.servers ?? [],
    mcpLog: made.read.mcpLog,
    mcpProblems: made.read.mcpProblems,
    canaryChanges: made.canaryChanges,
  };
}

/**
 * Runs one prompt, or the turns of a case, in one harness, in a fresh home and workspace that are removed afterwards.
 * @param input - The harness, the prompt or turns, and what to load.
 * @param use - Reads the result while the workspace still exists.
 * @returns What `use` returns.
 */
export async function session<T>(
  input: SessionInput,
  use: (result: SessionResult) => T | Promise<T>,
): Promise<T> {
  const { harness } = input;
  const home = tempDir("home-");
  const workspace = tempDir("proj-");
  // Under the sandbox the harness gets a temp directory of its own, the only one it may write to besides the two above.
  const tmp = input.sandbox ? tempDir("tmp-") : null;
  const run: SessionInput =
    input.sandbox && tmp
      ? { ...input, sandbox: { ...input.sandbox, tmp: tmp.dir } }
      : input;
  let prepared: PreparedRun | null = null;
  let mcp: McpStarted | null = null;
  try {
    prepared = await prepareOf(run, {
      workspace: workspace.dir,
      home: home.dir,
    });
    const seed = prepared?.seed ?? snapshot(workspace.dir);
    copyAuthFiles(harness.authFiles, home.dir);
    // The order is: setup steps, login files, mock servers, history and sessions, then the harness. A failed step means it never starts.
    const setupFailure = prepared?.failure ?? null;
    const place = { home: home.dir, workspace: workspace.dir };
    mcp =
      setupFailure === null && run.mcp
        ? startMcp(harness, run.mcp, place)
        : null;
    const dirs = { ...place, ...(mcp && { mcp: mcp.staged.dir }) };
    const seeded = setupFailure === null ? plantHistory(run, dirs) : UNSEEDED;
    // The rules go in once, before the first process, so that every turn of the case reads them.
    const rules =
      setupFailure === null && seeded.failure === null && run.rules
        ? installRulesFor(harness, run.rules, dirs)
        : null;
    const failure =
      setupFailure ?? seeded.failure ?? rules?.failure ?? mcp?.failure ?? null;
    const watched = run.canaries ? watchCanaries(run.canaries) : null;
    const done = run.turns
      ? await runTurns(run, { dirs, seed, failure, seeded })
      : await single(run, { dirs, failure, seeded });
    const canaryChanges = watched?.() ?? null;
    // Only now, with the agent gone, does the held-out directory exist anywhere the agent's tools could reach.
    const graderDir = prepared?.copies?.copyGrader() ?? null;
    const read = withMockLog(harness, done.end.parsed, mcp);
    return await use(
      resultOf(run, {
        ...{ seeded, done, read, dirs, seed },
        ...{ prepared, graderDir, rules, canaryChanges },
      }),
    );
  } finally {
    mcp?.staged.dispose();
    tmp?.dispose();
    prepared?.dispose();
    home.dispose();
    workspace.dispose();
  }
}
