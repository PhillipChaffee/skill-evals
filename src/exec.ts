import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
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
  /**
   * Stops the whole process group when the command itself exits, not only when its pipes close. Without it a
   * background process that keeps a pipe open holds the result back until the timeout. Default: false.
   */
  reapOnExit?: boolean | undefined;
  /** The most bytes kept of each of standard output and standard error; the rest is read and dropped. Default: all. */
  maxBytes?: number | undefined;
  /**
   * Called with each chunk of standard output as it arrives. Returning "stop" kills the whole process group, as a
   * timeout does, and the result is no failure: `stopped` is true. Output that arrives before the pipes close is kept.
   */
  onStdout?: ((chunk: string) => "continue" | "stop") | undefined;
}

/** What a finished command left behind. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Why it failed: a timeout, a non-zero exit with the end of its standard error, or a start that did not work. Null after exit code 0. */
  failure: string | null;
  /** The exit code; null when a signal ended the command or it never started. */
  exit: number | null;
  /** Which way it failed when it did not exit by itself; null for an exit, whatever its code. */
  kind: "timeout" | "spawn" | null;
  /** The signal that ended the command, when one did. */
  signal: string | null;
  /** True when more than `maxBytes` came out of either stream and the end was dropped. */
  truncated: boolean;
  /** True when `onStdout` asked for a stop and the process group was killed for it. Such a stop has no `failure`. */
  stopped: boolean;
  /** Milliseconds from the start of the command to its first byte on standard output; null when it wrote none. */
  firstOutputMs: number | null;
}

// After the process group is killed, a process outside it may still hold the pipes open. The output that is already
// buffered gets this long to arrive, then the pipes are let go.
const DRAIN_MS = 250;

/**
 * Keeps the start of a stream, up to a limit of bytes, and reads and drops the rest.
 * @param stream - A readable stream of the child process.
 * @param limit - The most bytes to keep.
 * @param seen - Called with every chunk, before it is kept or dropped.
 * @returns What is kept so far: its `text`, its size in `bytes`, and whether anything was dropped (`cut`).
 */
function keeper(
  stream: Readable,
  limit: number,
  seen?: (chunk: string) => void,
) {
  const kept = { text: "", bytes: 0, cut: false };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    seen?.(chunk);
    const size = Buffer.byteLength(chunk);
    if (kept.bytes + size <= limit) {
      kept.text += chunk;
      kept.bytes += size;
      return;
    }
    kept.cut = true;
    const room = limit - kept.bytes;
    if (room <= 0) return;
    kept.text += Buffer.from(chunk).subarray(0, room).toString("utf8");
    kept.bytes = limit;
  });
  return kept;
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

/** How a command ended. */
interface Ending {
  code: number | null;
  signal: string | null;
  /** The message of an error that stopped it from starting. */
  spawnError: string | undefined;
  timedOut: boolean;
  timeoutSeconds: number;
  /** True when `onStdout` asked for a stop that the runner's kill carried out: the command ended by a signal. */
  stopped: boolean;
}

/**
 * Turns what a command left and how it ended into its result.
 * @param kept - What was read from its streams.
 * @param kept.stdout - The kept start of standard output.
 * @param kept.stderr - The kept start of standard error.
 * @param kept.truncated - Whether either stream was cut.
 * @param kept.firstOutputMs - When the first byte of standard output came, or null.
 * @param how - How it ended.
 * @returns The result, with the failure text that matches the ending.
 */
function concluded(
  kept: {
    stdout: string;
    stderr: string;
    truncated: boolean;
    firstOutputMs: number | null;
  },
  how: Ending,
): ExecResult {
  const { code, signal } = how;
  const base = { ...kept, exit: code, signal, stopped: how.stopped };
  if (how.spawnError !== undefined) {
    const failure = how.spawnError;
    return { ...base, exit: null, signal: null, failure, kind: "spawn" };
  }
  // A timeout comes first: a command that was overdue was not stopped for anything else.
  if (how.timedOut) {
    const failure = `timed out after ${String(how.timeoutSeconds)} s`;
    return { ...base, stopped: false, failure, kind: "timeout" };
  }
  if (how.stopped) return { ...base, failure: null, kind: null };
  if (code === 0) return { ...base, failure: null, kind: null };
  const tail = kept.stderr.trim().slice(-SHOWN_STDERR_LENGTH);
  return {
    ...base,
    failure: `exit ${String(code ?? signal)}: ${tail}`,
    kind: null,
  };
}

/**
 * Stops every process of a group.
 * @param pid - The group leader's process id; none when the command never started.
 */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group already exited.
  }
}

/**
 * Starts the command, catching the faults that `spawn` throws instead of emitting, such as a working directory that
 * is a file.
 * @param bin - The executable.
 * @param args - Its arguments.
 * @param options - Where and with what to run it.
 * @returns The child process, or the message of the fault.
 */
function tryStart(bin: string, args: string[], options: ExecOptions) {
  try {
    return start(bin, args, options);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Runs a command to its end and never rejects.
 * @param bin - The executable.
 * @param args - Its arguments.
 * @param options - Where and with what to run it, and for how long.
 * @returns Everything the command wrote to both streams, and why it failed: a timeout, a non-zero exit with the end of
 *   its standard error, or a start that did not work. `failure` is null after exit code 0.
 */
export function exec(
  bin: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  const started = tryStart(bin, args, options);
  if (typeof started !== "string") return watch(started, options);
  const none = {
    stdout: "",
    stderr: "",
    truncated: false,
    firstOutputMs: null,
  };
  const { timeoutSeconds } = options;
  const how = {
    ...{ code: null, signal: null, timedOut: false, stopped: false },
    timeoutSeconds,
  };
  return Promise.resolve(concluded(none, { ...how, spawnError: started }));
}

/**
 * Starts reading both streams of a command. Standard output is also watched for its first byte and for the caller's
 * request to stop.
 * @param child - The started process.
 * @param options - How much to keep, and who may stop the command.
 * @param stop - Stops the command, when the first "stop" comes. Returns false when a stop no longer counts, because the
 *   command exited or its timeout fired.
 * @returns `kept` for what was read so far, and `stopped` for whether a stop was asked for.
 */
function readers(
  child: ReturnType<typeof start>,
  options: ExecOptions,
  stop: () => boolean,
) {
  const { maxBytes = Infinity, onStdout } = options;
  const began = Date.now();
  let first: number | null = null;
  let asked = false;
  const out = keeper(child.stdout, maxBytes, (chunk) => {
    first ??= Date.now() - began;
    if (asked || onStdout?.(chunk) !== "stop") return;
    asked = stop();
  });
  const err = keeper(child.stderr, maxBytes);
  const kept = () => ({
    ...{ stdout: out.text, stderr: err.text },
    truncated: out.cut || err.cut,
    firstOutputMs: first,
  });
  return {
    concluded: (how: Omit<Ending, "stopped">): ExecResult =>
      // A stop counts only when the runner's kill ended the command: it died of SIGKILL, the signal that kill sends.
      // An exit with a code, or another signal such as a crash's SIGSEGV, means it ended by itself, first. An external
      // SIGKILL in the same window is the accepted residual.
      concluded(kept(), {
        ...how,
        stopped:
          asked && how.signal === "SIGKILL" && how.spawnError === undefined,
      }),
  };
}

/**
 * Waits for a started command to end, kills its process group on a timeout or a stop that `onStdout` asks for, and
 * lets go of pipes that a process outside the group holds open.
 * @param child - The started process.
 * @param options - How long it may run, how much of its output to keep, whether to reap it on exit, and who may stop it.
 * @returns How it ended.
 */
function watch(
  child: ReturnType<typeof start>,
  options: ExecOptions,
): Promise<ExecResult> {
  const { timeoutSeconds } = options;
  return new Promise((resolve) => {
    const kill = (): void => {
      killGroup(child.pid);
    };
    // Runs when the child closes too, so nothing the command left in the background outlives the run.
    const reap = onDispose(kill);
    let timedOut = false;
    let ended: { code: number | null; signal: string | null } | null = null;
    let finished = false;
    const timers: NodeJS.Timeout[] = [];
    const killAndDrain = (): void => {
      kill();
      timers.push(
        setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          settle(ended?.code ?? null, ended?.signal ?? null);
        }, DRAIN_MS),
      );
    };
    const read = readers(child, options, () => {
      // Output that arrives after the command exited, or after the timeout fired, cannot stop anything.
      if (timedOut || ended !== null) return false;
      for (const timer of timers) clearTimeout(timer);
      killAndDrain();
      return true;
    });
    const settle = (
      code: number | null,
      signal: string | null,
      spawnError?: string,
    ): void => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      reap();
      resolve(
        read.concluded({ code, signal, spawnError, timedOut, timeoutSeconds }),
      );
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        killAndDrain();
      }, timeoutSeconds * MS_PER_SECOND),
    );
    child.on("error", (error) => {
      settle(null, null, error.message);
    });
    child.on("exit", (code, signal) => {
      ended = { code, signal };
      if (options.reapOnExit) killAndDrain();
    });
    child.on("close", settle);
  });
}
