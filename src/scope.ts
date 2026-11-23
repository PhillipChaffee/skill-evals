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
 * Tells whether a value is a plain object, and not a list or null.
 * @param value - Any parsed value.
 * @returns True for an object that is neither an array nor null.
 */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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
const interruptHooks = new Set<() => void>();
let signalled = false;

/**
 * Ends the process on SIGINT or SIGTERM. The hooks of `onInterrupt` run first, then the process exits with 130, which
 * runs the cleanups. A second signal while this runs ends the process at once.
 * @returns Never: the process exits.
 */
function interrupted(): never {
  if (signalled) return process.exit(INTERRUPTED_EXIT_CODE);
  signalled = true;
  for (const hook of [...interruptHooks]) {
    try {
      hook();
    } catch (error) {
      console.error(`skill-evals: interrupt hook failed: ${messageOf(error)}`);
    }
  }
  return process.exit(INTERRUPTED_EXIT_CODE);
}

/**
 * Registers what must happen when a signal ends the process, before the cleanups run: a command writes its partial
 * results here. The hook runs once, synchronously, and a hook that throws is reported and does not stop the others.
 * It has effect only while a cleanup is registered, as with `onDispose`.
 * @param hook - What to do on SIGINT or SIGTERM.
 * @returns Unregisters the hook.
 */
export function onInterrupt(hook: () => void): () => void {
  interruptHooks.add(hook);
  return () => {
    interruptHooks.delete(hook);
  };
}

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
      signalled = false;
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
 * The start of the name of every temp directory this tool makes. The agent may see them in a path, so none may hold a
 * blinding word, and a test checks that. A new prefix goes here first: `tempDir` takes nothing else.
 */
export const TEMP_PREFIXES = [
  "assets-",
  "copy-",
  "home-",
  "kit-",
  "path-",
  "proj-",
  "runs-",
  "skills-",
  "stage-",
  "store-",
  "svc-",
  "tmp-",
  "unpack-",
] as const;

/** One of `TEMP_PREFIXES`. */
export type TempPrefix = (typeof TEMP_PREFIXES)[number];

/**
 * Makes a temp directory whose name gives the agent no hint about why it exists.
 * @param prefix - The start of the directory name, one of `TEMP_PREFIXES`; random characters follow it.
 * @param beforeRemove - Runs just before the directory is removed, at the end of the run and at process exit.
 * @param parent - Where to make it. Default: the system's temp directory.
 * @returns The real path of the directory, and a `dispose` that removes it and also runs at process exit.
 */
export function tempDir(
  prefix: TempPrefix,
  beforeRemove?: (dir: string) => void,
  parent: string = os.tmpdir(),
): { dir: string; dispose: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(parent, prefix)));
  return {
    dir,
    dispose: onDispose(() => {
      beforeRemove?.(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    }),
  };
}
