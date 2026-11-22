import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A wrong command line, case file, or environment: reported without a stack trace, exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

/**
 * Reads the message of a caught value, which the language types as unknown.
 * @param error - What a `catch` clause received.
 * @returns The message of an Error, and the text form of any other thrown value.
 */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Stops a command before it does any work on a platform the harness runs do not support.
 * @throws {UsageError} On Windows, where process groups and the harness homes work differently.
 */
export function requireSupportedPlatform(): void {
  if (process.platform === "win32") {
    throw new UsageError("Windows is not supported; use macOS, Linux, or WSL");
  }
}

// The conventional exit code of a process that a signal ended: 128 + SIGINT.
const INTERRUPTED_EXIT_CODE = 130;

const live = new Set<() => void>();
/**
 * Runs every registered cleanup. One that throws is reported on standard error and does not stop the others: a later
 * cleanup may be what kills a process that is still running.
 */
export function runCleanups(): void {
  for (const dispose of [...live]) {
    try {
      dispose();
    } catch (error) {
      console.error(`skill-evals: cleanup failed: ${messageOf(error)}`);
    }
  }
}
process.on("exit", runCleanups);
const SIGNALS = ["SIGINT", "SIGTERM"] as const;
const interrupted = (): never => process.exit(INTERRUPTED_EXIT_CODE);

/**
 * Registers a cleanup that runs once: when the returned function is called, or when the process exits.
 * A signal ends the process only while a cleanup is registered, so a program that imports this keeps its own
 * signal handling the rest of the time.
 * @param cleanup - Removes what must not outlive the run. It may run during process exit, so it must be synchronous.
 * @returns Runs the cleanup now and unregisters it. A second call does nothing.
 */
export function onDispose(cleanup: () => void): () => void {
  const dispose = (): void => {
    if (!live.delete(dispose)) return;
    if (live.size === 0) {
      for (const signal of SIGNALS) process.off(signal, interrupted);
    }
    cleanup();
  };
  if (live.size === 0) {
    for (const signal of SIGNALS) process.on(signal, interrupted);
  }
  live.add(dispose);
  return dispose;
}

/**
 * Where a command's results go.
 * @param requested - The directory the user asked for, created when missing. Absent means a new temp directory.
 * @param cwd - What a relative `requested` resolves against.
 * @returns An absolute path to a directory that exists and that nothing removes afterwards.
 */
export function outputDir(requested: string | undefined, cwd: string): string {
  if (!requested) return fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
  const dir = path.resolve(cwd, requested);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Makes a temp directory whose name gives the agent no hint about why it exists.
 * @param prefix - The start of the directory name; random characters follow it.
 * @param beforeRemove - Runs just before the directory is removed, at the end of the run and at process exit.
 * @returns The real path of the directory, and a `dispose` that removes it and also runs at process exit.
 */
export function tempDir(
  prefix: string,
  beforeRemove?: (dir: string) => void,
): { dir: string; dispose: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return {
    dir,
    dispose: onDispose(() => {
      beforeRemove?.(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    }),
  };
}
