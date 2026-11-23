import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_BLINDING_WORDS, textHits } from "../blinding.js";

// The start of the name of the directories that `sandbox()` makes, which it removes when each test ends.
const SANDBOX_PREFIX = "runs-";

/**
 * Lists the sandbox directories that a test left behind.
 * @param dir - The tests' temp directory.
 * @returns The names in it that start with `runs-`, sorted.
 */
const leftovers = (dir: string): string[] =>
  fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(SANDBOX_PREFIX))
    .sort();

/**
 * Gives the whole test run a temp directory that holds no blinding word and no mention of this tool, whatever the
 * operator's is: a command that starts a real run checks TMPDIR before it starts. vitest.config.ts lists this file as
 * its global setup, which runs once, before any worker starts, so every worker inherits the TMPDIR it sets. The system's
 * temp directory is the parent unless its path holds a blinding word; then it is `/tmp`. PATH is left as it is: each
 * sandbox gives its command line a PATH of its own.
 * @returns The teardown, which removes the directory and everything in it, and fails the run when a sandbox directory
 *   is still there, since every test must remove its own.
 */
export default function setup(): () => void {
  const base =
    textHits(os.tmpdir(), DEFAULT_BLINDING_WORDS).length === 0
      ? os.tmpdir()
      : "/tmp";
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(base, SANDBOX_PREFIX)));
  process.env["TMPDIR"] = tmp;
  return () => {
    const left = leftovers(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (left.length > 0) {
      throw new Error(
        `the tests left ${String(left.length)} sandbox directories: ${left.join(", ")}`,
      );
    }
  };
}
