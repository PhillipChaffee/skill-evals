import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childEnv } from "./env.js";
import { exec } from "./exec.js";
import type { Harness, Parsed, RunInput } from "./harnesses/shared.js";
import { NOT_REPORTED, withIndexes } from "./harnesses/shared.js";
import { watchDirs } from "./isolate.js";
import { messageOf, tempDir } from "./scope.js";
import type { ChangedFiles, Snapshot } from "./snapshot.js";
import { mergeChanges, snapshot } from "./snapshot.js";
import type { Layers, PreparedRun } from "./workspace.js";
import { copyHome, prepareRun } from "./workspace.js";

/** One prompt for one harness. */
export interface SessionInput {
  harness: Harness;
  /** The harness's executable. */
  bin: string;
  /** What the harness loads; null loads nothing. */
  subject: RunInput["subject"];
  prompt: string;
  model?: string | undefined;
  maxTurns?: number | undefined;
  /** Start the harness with nothing loaded but the subject. */
  isolated?: boolean | undefined;
  timeoutSeconds: number;
  /** What the case puts in the workspace and the home, and the steps that set it up; absent for an empty workspace. */
  layers?: Layers | undefined;
  /** Environment variables the harness must not get, such as the key of the model that scores its answer. */
  withhold?: string[] | undefined;
  /** Names of this process's variables the project's config passes to the harness. */
  pass?: string[] | undefined;
  /** Variables a case sets for the agent, with their values. They reach the agent's process only. */
  env?: Record<string, string> | undefined;
}

/** What a session produced, seen while its workspace still exists. */
export interface SessionResult {
  stdout: string;
  parsed: Parsed;
  /** The harness's own message when it produced a stream, else why the process failed. */
  error: string | null;
  durationMs: number;
  workspace: string;
  /**
   * What the run changed in the copies of the skills that the adapter placed in the home, as paths inside the
   * subject; null when the adapter placed none.
   */
  placedChanges: ChangedFiles | null;
  /** The workspace as the agent starts from it: the copies and the setup steps done. */
  seed: Snapshot;
  /** The run's throwaway home, which exists until the callback returns. */
  home: string;
  /** The home just before the harness's prompt ran: the auth files, the placed skills, and what setup wrote. */
  homeSeed: Snapshot;
  /** Where the adapter placed each skill: skill name to directory; absent when it placed none. */
  placed: Record<string, string> | undefined;
  /** The workspace as the copy left it, kept as a directory; null unless the case has a command check. */
  seedDir: string | null;
  /** The run's directory for bare remotes and linked worktrees, which exists until the callback returns; null without a case. */
  remoteDir: string | null;
  /** The held-out directory, copied after the agent exited; null when the case has none or has no command check. */
  graderDir: string | null;
}

// Login files hold secrets, so only the owner may read the copies.
const OWNER_READ_WRITE = 0o600;
const SHOWN_SETUP_WORDS = 2;

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
 * Starts watching the copies of skills that an adapter placed in the home.
 * @param subject - What the run loads.
 * @param placed - Skill name to the directory of its copy, as the adapter reported it.
 * @returns A function that lists what changed in them since now, or null when the adapter placed none.
 */
function watchPlaced(
  subject: RunInput["subject"],
  placed: Record<string, string> | undefined,
): () => ChangedFiles | null {
  const dirs = Object.entries(placed ?? {}).map(([name, dir]) => ({
    dir,
    prefix: path
      .relative(subject?.dir ?? "", subject?.skillDirs[name] ?? "")
      .split(path.sep)
      .join("/"),
  }));
  return dirs.length === 0 ? () => null : watchDirs(dirs);
}

/**
 * Makes the function that builds the harness's environment.
 * @param session - Which harness, and what it may and may not get.
 * @param home - The throwaway home.
 * @param harnessEnv - What the adapter's invocation sets.
 * @returns A function from the case's own variables to the whole environment.
 */
const environmentOf =
  (session: SessionInput, home: string, harnessEnv: Record<string, string>) =>
  (caseEnv: Record<string, string>) =>
    childEnv({
      home,
      base: process.env,
      harnessEnv,
      authEnv: session.harness.authEnv,
      pass: session.pass ?? [],
      withhold: session.withhold ?? [],
      caseEnv,
    });

/**
 * Runs the harness's setup steps, in order, until one fails.
 * @param bin - The harness's executable.
 * @param steps - The argument lists of the steps.
 * @param options - Where and how to run them.
 * @param options.cwd - The workspace.
 * @param options.env - The environment of the harness.
 * @param options.timeoutSeconds - How long each step may take.
 * @returns Why the first failing step failed, naming its first words; null when every step worked.
 */
async function setupFailure(
  bin: string,
  steps: string[][],
  options: { cwd: string; env: Record<string, string>; timeoutSeconds: number },
): Promise<string | null> {
  for (const step of steps) {
    const { failure } = await exec(bin, step, options);
    if (failure) {
      const command = step.slice(0, SHOWN_SETUP_WORDS).join(" ");
      return `setup "${command}": ${failure}`;
    }
  }
  return null;
}

/**
 * Finds the skill copies that the harness made itself during setup, and starts watching them.
 * @param harness - The adapter, which may know where its setup put them.
 * @param input - What the adapter builds the command line from.
 * @returns The copies, and a function that lists what changed in them since now.
 */
function afterSetup(
  harness: Harness,
  input: RunInput,
): { placed: Record<string, string>; changes: () => ChangedFiles | null } {
  const placed = harness.placedAfterSetup?.(input) ?? {};
  return { placed, changes: watchPlaced(input.subject, placed) };
}

/**
 * Joins two lists of changes, either of which may be absent.
 * @param first - The changes of the copies the adapter placed.
 * @param second - The changes of the copies the harness made in setup.
 * @returns Both merged; whichever exists when only one does; null when neither does.
 */
const joined = (
  first: ChangedFiles | null,
  second: ChangedFiles | null,
): ChangedFiles | null =>
  first && second ? mergeChanges(first, second) : (first ?? second);

/**
 * Makes the result of a run whose harness never started.
 * @param failure - Why: the setup step that failed.
 * @param home - The run's throwaway home.
 * @returns What `attempt` returns, with no output and no time.
 */
const notStarted = (failure: string, home: string) => ({
  stdout: "",
  failure,
  durationMs: 0,
  placedChanges: null,
  placed: undefined,
  homeSeed: snapshot(home),
});

/**
 * Prepares the harness and runs the prompt.
 * @param session - Which harness, and how long it may take.
 * @param input - What the adapter builds the command line from.
 * @returns The harness's output, why it failed if it did, and how long the prompt itself took; setup is not timed.
 */
async function attempt(
  session: SessionInput,
  input: RunInput,
): Promise<{
  stdout: string;
  failure: string | null;
  durationMs: number;
  placedChanges: ChangedFiles | null;
  placed?: Record<string, string> | undefined;
  homeSeed: Snapshot;
}> {
  const { harness, bin, timeoutSeconds } = session;
  let invocation;
  try {
    invocation = harness.invocation(input);
  } catch (error) {
    return notStarted(
      `could not prepare the run: ${messageOf(error)}`,
      input.home,
    );
  }
  const placedChanges = watchPlaced(input.subject, invocation.placed);
  const environment = environmentOf(session, input.home, invocation.env);
  const options = {
    cwd: input.workspace,
    env: environment({}),
    timeoutSeconds,
  };
  const failure = await setupFailure(bin, invocation.setup ?? [], options);
  if (failure) {
    return {
      stdout: "",
      failure,
      durationMs: 0,
      placedChanges: placedChanges(),
      placed: invocation.placed,
      homeSeed: snapshot(input.home),
    };
  }
  const late = afterSetup(harness, input);
  const clash = copyHome(session.layers?.homeDir ?? null, input.home);
  if (clash) return notStarted(clash, input.home);
  const homeSeed = snapshot(input.home);
  const started = Date.now();
  const result = await exec(bin, invocation.args, {
    ...options,
    env: environment(session.env ?? {}),
    stdin: invocation.stdin,
    // Whatever the agent left running goes with it, so a background process cannot hold the run until its time limit.
    reapOnExit: true,
  });
  return {
    ...result,
    durationMs: Date.now() - started,
    placedChanges: joined(placedChanges(), late.changes()),
    placed: { ...invocation.placed, ...late.placed },
    homeSeed,
  };
}

/**
 * Normalizes a harness's output.
 * @param harness - The adapter that reads the stream.
 * @param stdout - What the harness wrote.
 * @returns What the adapter read, with an error in place of an exception for a stream the adapter cannot read.
 */
function parseStream(harness: Harness, stdout: string): Parsed {
  try {
    const parsed = harness.parse(stdout);
    return { ...parsed, toolCalls: withIndexes(parsed.toolCalls) };
  } catch (error) {
    return {
      finalText: "",
      toolCalls: [],
      transcript: [],
      sessionId: null,
      tokens: null,
      costUsd: null,
      loaded: NOT_REPORTED,
      error: `the ${harness.id} adapter could not read the stream: ${messageOf(error)}`,
    };
  }
}

/**
 * Runs one prompt in one harness, in a fresh home and workspace that are removed afterwards.
 * @param run - The harness, the prompt, and what to load.
 * @param use - Reads the result while the workspace still exists.
 * @returns What `use` returns.
 */
export async function session<T>(
  run: SessionInput,
  use: (result: SessionResult) => T | Promise<T>,
): Promise<T> {
  const { harness, subject, prompt, model, maxTurns } = run;
  const { isolated } = run;
  const home = tempDir("home-");
  const workspace = tempDir("proj-");
  let prepared: PreparedRun | null = null;
  try {
    // Setup runs before the login files are in the home, so no step can read them.
    prepared = run.layers
      ? await prepareRun(run.layers, {
          workspace: workspace.dir,
          home: home.dir,
        })
      : null;
    const seed = prepared?.seed ?? snapshot(workspace.dir);
    copyAuthFiles(harness.authFiles, home.dir);
    const input = {
      subject,
      home: home.dir,
      workspace: workspace.dir,
      prompt,
      model,
      maxTurns,
      isolated,
    };
    // A failed setup step means the harness never starts.
    const { stdout, failure, durationMs, placedChanges, placed, homeSeed } =
      prepared?.failure
        ? notStarted(prepared.failure, home.dir)
        : await attempt(run, input);
    // Only now, with the agent gone, does the held-out directory exist anywhere the agent's tools could reach.
    const graderDir = prepared?.copies?.copyGrader() ?? null;
    const parsed = parseStream(harness, stdout);
    // The harness's own message is the most specific one, but only when it produced a stream at all.
    const error =
      (stdout.trim() && parsed.error) || failure || parsed.error || null;
    return await use({
      stdout,
      parsed,
      error,
      durationMs,
      workspace: workspace.dir,
      seed,
      placedChanges,
      home: home.dir,
      homeSeed,
      placed,
      seedDir: prepared?.seedDir ?? null,
      remoteDir: prepared?.remoteDir ?? null,
      graderDir,
    });
  } finally {
    prepared?.dispose();
    home.dispose();
    workspace.dispose();
  }
}
