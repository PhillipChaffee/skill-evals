import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { UsageError } from "./scope.js";
import { canonical, hashTree, sha256 } from "./tree-hash.js";

const APPROVED_FILE = "approved.json";
const YES = /^\s*y(es)?\s*$/i;
const INDENT = 2;

/** How a command talks to the person who runs it. */
export interface Terminal {
  /** True when standard input is a terminal that someone can answer on. */
  interactive: boolean;
  /** Writes the question and reads one line. */
  ask: (question: string) => Promise<string>;
}

/**
 * Finds the directory where skill-evals keeps what it remembers.
 * @param env - The environment to read. Default: the process's.
 * @returns `$SKILL_EVALS_STATE_DIR`, else `$XDG_STATE_HOME/skill-evals`, else `~/.local/state/skill-evals`.
 */
export function stateDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const own = env["SKILL_EVALS_STATE_DIR"];
  if (own) return own;
  const xdg = env["XDG_STATE_HOME"];
  return xdg
    ? path.join(xdg, "skill-evals")
    : path.join(os.homedir(), ".local", "state", "skill-evals");
}

/**
 * Reads a file's text.
 * @param file - A path.
 * @returns The text; null when there is no such file.
 */
function textOf(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Hashes a cases directory as the approval knows it.
 * @param casesDir - The directory.
 * @param configFile - The project's config file, whose `env`, `judgeUrl` and `rules` change what a run does; absent: none.
 * @returns The sha256 of the directory's real path and content and the config file's content, so that moving it or
 *   changing a file makes it a new directory.
 */
export const digestOf = (
  casesDir: string,
  configFile?: string | null,
): string => {
  const config = configFile ? textOf(configFile) : null;
  return sha256(
    canonical({
      path: fs.realpathSync(casesDir),
      content: hashTree(casesDir),
      config: config === null ? null : sha256(config),
    }),
  );
};

/**
 * Reads the approvals.
 * @param file - `approved.json` in the state directory.
 * @returns The approved digests, each with the path it was approved at; empty when the file is missing or unreadable.
 */
function approvals(file: string): Record<string, string> {
  try {
    const read: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return read !== null && typeof read === "object" && !Array.isArray(read)
      ? (read as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Makes a terminal of the process's own streams.
 * @param input - Where the answer is read from. Default: standard input.
 * @param output - Where the question is written. Default: standard error, which keeps a report on standard output clean.
 * @returns A terminal that writes its question to `output` and reads one line from `input`.
 */
export function processTerminal(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): Terminal {
  return {
    // A stream that is no terminal has no `isTTY` at all.
    interactive: (input as { isTTY?: boolean }).isTTY === true,
    ask: async (question) => {
      const lines = createInterface({ input, output });
      try {
        return await lines.question(question);
      } finally {
        lines.close();
      }
    },
  };
}

/**
 * Makes sure that someone has agreed to run the prompts of a cases directory. The prompts run unattended with full
 * permissions, so a directory that this machine has not seen is asked about first.
 * @param what - The cases directory and how many of its cases are about to run.
 * @param what.casesDir - The directory.
 * @param what.count - The number of selected cases.
 * @param what.configFile - The project's config file, which is part of what is approved.
 * @param how - How to ask.
 * @param how.yes - `--yes`: run without asking, and without remembering.
 * @param how.terminal - Where the question goes. Default: the process's streams.
 * @param how.env - The environment that names the state directory. Default: the process's.
 * @throws {UsageError} When the directory is new or changed and there is no terminal and no `--yes`, or the answer is no.
 */
export async function requireApproved(
  what: { casesDir: string; count: number; configFile?: string | null },
  how: {
    yes?: boolean | undefined;
    terminal?: Terminal | undefined;
    env?: Record<string, string | undefined> | undefined;
  },
): Promise<void> {
  if (how.yes) return;
  const file = path.join(stateDir(how.env), APPROVED_FILE);
  const digest = digestOf(what.casesDir, what.configFile);
  if (Object.hasOwn(approvals(file), digest)) return;
  const terminal = how.terminal ?? processTerminal();
  if (!terminal.interactive) {
    throw new UsageError(
      `${what.casesDir} has not been approved: its prompts run unattended with full permissions. Read them with "skill-evals list --show-prompts", then run again with --yes`,
    );
  }
  const cases = `${String(what.count)} ${what.count === 1 ? "case" : "cases"}`;
  const answer = await terminal.ask(
    `${what.casesDir} has not been approved (see them with "skill-evals list --show-prompts"). Run these ${cases}? [y/N] `,
  );
  if (!YES.test(answer)) throw new UsageError("not approved; nothing was run");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({ ...approvals(file), [digest]: fs.realpathSync(what.casesDir) }, null, INDENT)}\n`,
    );
  } catch (error) {
    console.error(
      `skill-evals: warning: could not save the approval in ${file}: ${error instanceof Error ? error.message : String(error)}; approved for this run only`,
    );
  }
}
