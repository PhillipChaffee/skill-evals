import { spawn } from "node:child_process";
import { onDispose } from "./scope.js";

const MS_PER_SECOND = 1000;
// How much of a failed command's standard error goes into the failure text.
const SHOWN_STDERR_LENGTH = 400;

/** How to run one command. */
export interface ExecOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutSeconds: number;
  /** Written to the command's standard input. Absent means the command gets no input at all. */
  stdin?: string | undefined;
}

/**
 * Starts a command in its own process group, so a timeout or an interrupt also stops whatever the command started.
 * @param bin - The executable.
 * @param args - Its arguments.
 * @param run - Where and with what to run it.
 * @returns The child process, with its standard input already written and closed.
 */
function start(bin: string, args: string[], run: ExecOptions) {
  const { cwd, env, stdin } = run;
  const options = { cwd, env, detached: true };
  if (stdin === undefined) {
    return spawn(bin, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  }
  const child = spawn(bin, args, {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // A command that exits without reading its input must not take this process down with EPIPE.
  child.stdin.on("error", () => undefined);
  child.stdin.end(stdin);
  return child;
}

/**
 * Runs a command to its end and never rejects.
 * @param bin - The executable.
 * @param args - Its arguments.
 * @param options - Where and with what to run it, and for how long.
 * @returns Everything the command wrote to standard output, and why it failed: a timeout, a non-zero exit with the
 *   end of its standard error, or a start that did not work. `failure` is null after exit code 0.
 */
export function exec(
  bin: string,
  args: string[],
  options: ExecOptions,
): Promise<{ stdout: string; failure: string | null }> {
  const { timeoutSeconds } = options;
  return new Promise((resolve) => {
    const child = start(bin, args, options);
    const kill = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group already exited.
      }
    };
    // Runs when the child closes too, so nothing the command left in the background outlives the run.
    const reap = onDispose(kill);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutSeconds * MS_PER_SECOND);
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const finish = (failure: string | null): void => {
      clearTimeout(timer);
      reap();
      resolve({ stdout, failure });
    };
    child.on("error", (error) => {
      finish(error.message);
    });
    child.on("close", (code, signal) => {
      if (timedOut) finish(`timed out after ${String(timeoutSeconds)} s`);
      else if (code === 0) finish(null);
      else {
        const tail = stderr.trim().slice(-SHOWN_STDERR_LENGTH);
        finish(`exit ${String(code ?? signal)}: ${tail}`);
      }
    });
  });
}
