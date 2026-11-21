import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childEnv } from "./env.js";
import { exec } from "./exec.js";
import type { Harness, Parsed, RunInput } from "./harnesses/shared.js";
import { NOT_REPORTED } from "./harnesses/shared.js";
import { watchDirs } from "./isolate.js";
import { messageOf, tempDir } from "./scope.js";
import type { ChangedFiles } from "./snapshot.js";

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
  /** Copied into the workspace before the harness starts. */
  workspaceDir?: string | null;
  /** Environment variables the harness must not get, such as the key of the model that scores its answer. */
  withhold?: string[] | undefined;
  /** Names of this process's variables the project's config passes to the harness. */
  pass?: string[] | undefined;
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
  /** The run's throwaway home, which exists until the callback returns. */
  home: string;
  /** Where the adapter placed each skill: skill name to directory; absent when it placed none. */
  placed: Record<string, string> | undefined;
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
}> {
  const { harness, bin, timeoutSeconds } = session;
  let invocation;
  try {
    invocation = harness.invocation(input);
  } catch (error) {
    const failure = `could not prepare the run: ${messageOf(error)}`;
    return { stdout: "", failure, durationMs: 0, placedChanges: null };
  }
  const placedChanges = watchPlaced(input.subject, invocation.placed);
  const options = {
    cwd: input.workspace,
    env: childEnv({
      home: input.home,
      base: process.env,
      harnessEnv: invocation.env,
      authEnv: harness.authEnv,
      pass: session.pass ?? [],
      withhold: session.withhold ?? [],
    }),
    timeoutSeconds,
  };
  for (const step of invocation.setup ?? []) {
    const { failure } = await exec(bin, step, options);
    if (failure) {
      const command = step.slice(0, SHOWN_SETUP_WORDS).join(" ");
      return {
        stdout: "",
        failure: `setup "${command}": ${failure}`,
        durationMs: 0,
        placedChanges: placedChanges(),
        placed: invocation.placed,
      };
    }
  }
  const started = Date.now();
  const result = await exec(bin, invocation.args, {
    ...options,
    stdin: invocation.stdin,
  });
  return {
    ...result,
    durationMs: Date.now() - started,
    placedChanges: placedChanges(),
    placed: invocation.placed,
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
    return harness.parse(stdout);
  } catch (error) {
    return {
      finalText: "",
      toolCalls: [],
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
  const { harness, subject, prompt, model, maxTurns, workspaceDir } = run;
  const { isolated } = run;
  const home = tempDir("home-");
  const workspace = tempDir("proj-");
  try {
    if (workspaceDir) {
      fs.cpSync(workspaceDir, workspace.dir, { recursive: true });
    }
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
    const { stdout, failure, durationMs, placedChanges, placed } =
      await attempt(run, input);
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
      placedChanges,
      home: home.dir,
      placed,
    });
  } finally {
    home.dispose();
    workspace.dispose();
  }
}
