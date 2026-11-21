import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecOptions } from "./exec.js";
import { exec } from "./exec.js";
import type { Harness, Parsed, RunInput } from "./harnesses/shared.js";
import { messageOf, tempDir } from "./scope.js";

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
  timeoutSeconds: number;
  /** Copied into the workspace before the harness starts. */
  workspaceDir?: string | null;
}

/** What a session produced, seen while its workspace still exists. */
export interface SessionResult {
  stdout: string;
  parsed: Parsed;
  /** The harness's own message when it produced a stream, else why the process failed. */
  error: string | null;
  durationMs: number;
  workspace: string;
}

// This tool's own variables, and the ones npm and the shell set that name the command that is running.
const NAMES_THIS_TOOL = /^(SKILL_EVALS_|npm_|_$)/;
// Login files hold secrets, so only the owner may read the copies.
const OWNER_READ_WRITE = 0o600;
const SHOWN_SETUP_WORDS = 2;

/**
 * Builds the environment of the harness process.
 * @param home - The throwaway home.
 * @param extra - What the adapter adds.
 * @returns This process's environment, with the home and the XDG directories moved under `home`, and without any
 *   variable that names this tool.
 */
function childEnv(
  home: string,
  extra: Record<string, string>,
): ExecOptions["env"] {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !NAMES_THIS_TOOL.test(key)),
  );
  return {
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    ...extra,
  };
}

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
 * Prepares the harness and runs the prompt.
 * @param session - Which harness, and how long it may take.
 * @param input - What the adapter builds the command line from.
 * @returns The harness's output, why it failed if it did, and how long the prompt itself took; setup is not timed.
 */
async function attempt(
  session: SessionInput,
  input: RunInput,
): Promise<{ stdout: string; failure: string | null; durationMs: number }> {
  const { harness, bin, timeoutSeconds } = session;
  let invocation;
  try {
    invocation = harness.invocation(input);
  } catch (error) {
    const failure = `could not prepare the run: ${messageOf(error)}`;
    return { stdout: "", failure, durationMs: 0 };
  }
  const options = {
    cwd: input.workspace,
    env: childEnv(input.home, invocation.env),
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
      };
    }
  }
  const started = Date.now();
  const result = await exec(bin, invocation.args, {
    ...options,
    stdin: invocation.stdin,
  });
  return { ...result, durationMs: Date.now() - started };
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
      loaded: { paths: null, skills: null },
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
    };
    const { stdout, failure, durationMs } = await attempt(run, input);
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
    });
  } finally {
    home.dispose();
    workspace.dispose();
  }
}
