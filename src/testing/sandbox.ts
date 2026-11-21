import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, vi } from "vitest";
import { main } from "../cli.js";
import type { Results } from "../evaluate.js";

const fixturesDir = path.resolve(import.meta.dirname, "../../test/fixtures");

/**
 * Locates a file of `test/fixtures`.
 * @param name - The file name: a captured stream, or one of the stand-in harness executables.
 * @returns Its absolute path.
 */
export const fixture = (name: string): string => path.join(fixturesDir, name);

/** A stand-in harness executable that speaks Claude Code's stream format and runs no model. */
export const fakeHarness = fixture("fake-harness.mjs");

// What npm and the shell put in the environment of a command started with `npx skill-evals`.
const LAUNCHED_BY_NPX = {
  npm_lifecycle_script: "skill-evals",
  _: "/project/node_modules/.bin/skill-evals",
};

/** What a command line did. */
interface CliResult {
  /** The exit code. */
  status: number;
  stdout: string;
  stderr: string;
}

/** What the fake harness reports as its final text: what it saw of the run. */
export interface Seen {
  seed: string;
  leaks: number;
  home: string;
  cwd: string;
  prompt: string;
  model: string | null;
  skills: Record<string, string>;
  credentials: string | null;
}

/**
 * Runs code as a process with exactly this environment and working directory would, and captures what it prints.
 * The harness under test stays a real child process; only the code of this package runs in the test's own process,
 * where the coverage tool can see it.
 * @param setting - The whole environment, which replaces the test runner's, and the working directory.
 * @param setting.env - Every environment variable the code may see.
 * @param setting.cwd - What `process.cwd()` returns.
 * @param run - The code to run.
 * @returns What `run` resolved with, and everything written with `console.log` and `console.error`.
 */
export async function asProcess<T>(
  setting: { env: Record<string, string>; cwd: string },
  run: () => Promise<T>,
): Promise<{ value: T; stdout: string; stderr: string }> {
  const printed = { log: [] as string[], error: [] as string[] };
  const capture = (method: "log" | "error") =>
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
      printed[method].push(`${parts.join(" ")}\n`);
    });
  const spies = [
    capture("log"),
    capture("error"),
    vi.spyOn(process, "cwd").mockReturnValue(setting.cwd),
  ];
  for (const key of Object.keys(process.env)) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(setting.env))
    vi.stubEnv(key, value);
  try {
    const value = await run();
    return {
      value,
      stdout: printed.log.join(""),
      stderr: printed.error.join(""),
    };
  } finally {
    vi.unstubAllEnvs();
    for (const spy of spies) spy.mockRestore();
  }
}

/** A throwaway directory to build a project in, and a command line that runs there. */
export interface Sandbox {
  root: string;
  /** Writes a file under the root and returns its path. Content that is not text is written as JSON. */
  write: (relative: string, content: unknown) => string;
  /** Runs `skill-evals` with these arguments, extra environment variables, and working directory (default: the root). */
  cli: (
    args: string[],
    env?: Record<string, string>,
    cwd?: string,
  ) => Promise<CliResult>;
  /** The environment `cli` runs with. */
  env: Record<string, string>;
}

/**
 * Makes a temp directory, removed when the test ends, with a `cli` that sees no installed harness but the fake one,
 * behind the Claude Code adapter.
 * @returns The sandbox. Its root is also the home directory of the command line.
 */
export function sandbox(): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runs-")));
  onTestFinished(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (relative: string, content: unknown): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      typeof content === "string" ? content : JSON.stringify(content),
    );
    return file;
  };
  // A PATH that holds node and git and nothing else, so no harness installed on this machine can be picked up.
  fs.mkdirSync(path.join(root, "bin"));
  fs.symlinkSync(process.execPath, path.join(root, "bin/node"));
  const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(git, path.join(root, "bin/git"));
  const env = {
    PATH: path.join(root, "bin"),
    HOME: root,
    SKILL_EVALS_BIN_CLAUDE_CODE: fakeHarness,
    ...LAUNCHED_BY_NPX,
  };
  const cli: Sandbox["cli"] = async (args, extra = {}, cwd = root) => {
    const setting = { env: { ...env, ...extra }, cwd };
    const ran = await asProcess(setting, () => main(args));
    return { status: ran.value, stdout: ran.stdout, stderr: ran.stderr };
  };
  return { root, write, cli, env };
}

/**
 * Makes a directory a git repository with one commit on the branch `trunk`.
 * @param dir - An existing directory.
 * @returns Runs a git command in the repository and resolves with its trimmed output.
 */
export function gitRepo(dir: string): (...args: string[]) => string {
  const identity = ["user.name=t", "user.email=t@example.com"];
  const config = [...identity, "commit.gpgsign=false"].flatMap((setting) => [
    "-c",
    setting,
  ]);
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...config, ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "trunk");
  git("commit", "-q", "--allow-empty", "-m", "start");
  return git;
}

/**
 * Reads what a `run` or `score` command wrote.
 * @param outDir - The command's output directory.
 * @returns The parsed `results.json`.
 */
export const readResults = (outDir: string): Results =>
  JSON.parse(
    fs.readFileSync(path.join(outDir, "results.json"), "utf8"),
  ) as Results;

/**
 * Reads what the fake harness saw of a run.
 * @param finalText - The final text of a run record, or the content of a `.final.md` file.
 * @returns The fake harness's report.
 */
export const seenBy = (finalText: string): Seen =>
  JSON.parse(finalText) as Seen;

/**
 * Finds the table row of a report or of the `check` listing.
 * @param stdout - What the command printed.
 * @param first - The text of the row's first cell: a case id or a harness id.
 * @returns The row, or an empty string when the table has no such row.
 */
export const tableRow = (stdout: string, first: string): string =>
  stdout.split("\n").find((line) => line.startsWith(`| ${first} |`)) ?? "";
