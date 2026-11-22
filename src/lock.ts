import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError, onDispose } from "./scope.js";

const LOCK_FILE = ".lock";
const TAKEOVER_FILE = ".lock.takeover";
// The stat field that holds a process's start time, counted after the command name and the state letter.
const START_TIME_FIELD = 19;
const ATTEMPTS = 3;
// The characters between the last bracket of the command name and the first stat field after it.
const AFTER_NAME = 2;

/** Who holds a lock. */
interface Holder {
  pid: number;
  hostname: string;
  /** The boot of the machine, where `/proc` names it; null elsewhere. */
  bootId: string | null;
  /** Field 22 of `/proc/<pid>/stat`, which tells a process from a later one that got its pid; null without `/proc`. */
  startTime: string | null;
}

/** The locks that this process holds, by file. A lock that names this process and is not here is a leftover. */
const held = new Set<string>();

/**
 * Reads the boot id of the machine.
 * @returns The id; null where `/proc` has none.
 */
function bootId(): string | null {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Reads when a process started.
 * @param pid - A process id.
 * @returns Field 22 of `/proc/<pid>/stat`, in clock ticks since boot; null where `/proc` does not tell.
 */
export function startTimeOf(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    // The command name may hold spaces and brackets, so the fields are counted after its last bracket.
    const rest = stat.slice(stat.lastIndexOf(")") + AFTER_NAME).split(" ");
    return rest[START_TIME_FIELD] ?? null;
  } catch {
    return null;
  }
}

/**
 * Describes this process for the lock file.
 * @returns Its pid, host, boot and start time.
 */
const self = (): Holder => ({
  pid: process.pid,
  hostname: os.hostname(),
  bootId: bootId(),
  startTime: startTimeOf(process.pid),
});

/**
 * Reads the text of a lock file.
 * @param text - What the file holds.
 * @returns The holder; null when the text is not a lock this tool wrote.
 */
function parse(text: string): Holder | null {
  try {
    const value = JSON.parse(text) as Partial<Holder> | null;
    const { pid, hostname } = value ?? {};
    // A pid of 0 or below would signal a process group, so it is no lock.
    if (!Number.isInteger(pid) || (pid as number) < 1) return null;
    if (typeof hostname !== "string") return null;
    return {
      pid: pid as number,
      hostname,
      bootId: value?.bootId ?? null,
      startTime: value?.startTime ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Tells whether a process is alive.
 * @param pid - A process id.
 * @returns False when no such process exists; a process that this user may not signal is alive.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** What a lock file means now: held by a live command, written on another host or boot, or left behind. */
type Verdict = "live" | "foreign" | "stale";

/**
 * Judges a lock.
 * @param file - The lock file.
 * @param holder - Who wrote it.
 * @returns "foreign" for another host or boot, which this process cannot check. On this host and boot, "live" only
 *   when the holder's pid is alive and, where `/proc` tells, started when the lock says; a lock that names this
 *   process but is not held in memory is "stale".
 */
function judge(file: string, holder: Holder): Verdict {
  const boot = bootId();
  if (
    holder.hostname !== os.hostname() ||
    (holder.bootId !== null && boot !== null && holder.bootId !== boot)
  ) {
    return "foreign";
  }
  if (holder.pid === process.pid) return held.has(file) ? "live" : "stale";
  if (!alive(holder.pid)) return "stale";
  const now = startTimeOf(holder.pid);
  return holder.startTime !== null && now !== null && holder.startTime !== now
    ? "stale"
    : "live";
}

/**
 * Words why a lock cannot be taken.
 * @param file - The lock file.
 * @param holder - Who wrote it.
 * @param verdict - "live" or "foreign".
 * @returns The message, which names the file.
 */
const refusal = (file: string, holder: Holder, verdict: Verdict): string =>
  verdict === "live"
    ? `${file}: process ${String(holder.pid)} on ${holder.hostname} is using this output directory; wait for it, or choose another --out`
    : `${file} was written by process ${String(holder.pid)} on host ${holder.hostname}, which this machine cannot check; remove ${file} if no command is using ${path.dirname(file)}, or choose another --out`;

/**
 * Reads the lock of an output directory.
 * @param file - The lock file.
 * @returns Its text and holder (null for text that is no lock); null when there is no lock.
 */
function read(file: string): { text: string; holder: Holder | null } | null {
  try {
    const text = fs.readFileSync(file, "utf8");
    return { text, holder: parse(text) };
  } catch {
    return null;
  }
}

/**
 * Refuses an output directory that another command holds. It changes nothing.
 * @param outDir - The output directory.
 * @throws {UsageError} When its lock is held by a live command, or was written on another host or boot.
 */
export function requireUnlocked(outDir: string): void {
  const file = path.join(outDir, LOCK_FILE);
  const found = read(file);
  if (found === null || found.holder === null) return;
  const verdict = judge(file, found.holder);
  if (verdict !== "stale") {
    throw new UsageError(refusal(file, found.holder, verdict));
  }
}

/**
 * Creates a file that must not exist yet.
 * @param file - Its path.
 * @param text - What it holds.
 * @returns False when it exists; true when it was created.
 * @throws {Error} For any other failure.
 */
function create(file: string, text: string): boolean {
  try {
    fs.writeFileSync(file, text, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Removes a stale lock, once. Only one command at a time may do it, and only a lock that still says what was judged.
 * @param file - The lock file.
 * @param text - What the stale lock held when it was judged.
 * @param holder - Who wrote it; null for text that is no lock.
 */
function takeOver(file: string, text: string, holder: Holder | null): void {
  const guard = path.join(path.dirname(file), TAKEOVER_FILE);
  if (!create(guard, "")) return;
  try {
    if (read(file)?.text === text) {
      console.error(
        `skill-evals: warning: took over ${file}, ${holder === null ? "which was not a lock" : `held by process ${String(holder.pid)}, which is gone`}`,
      );
      fs.rmSync(file, { force: true });
    }
  } finally {
    fs.rmSync(guard, { force: true });
  }
}

/**
 * Takes the lock of an output directory, so that two commands never write the same results.
 * @param outDir - The output directory, which exists.
 * @returns Releases the lock. It also runs when the process exits, and a second call does nothing.
 * @throws {UsageError} When a live command holds the lock, or it was written on another host or boot, or it cannot be
 *   taken after a few tries. Every message names the lock file. A stale lock is taken over, with a warning.
 */
export function lockDir(outDir: string): () => void {
  const file = path.join(outDir, LOCK_FILE);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (create(file, JSON.stringify(self()))) {
      held.add(file);
      const release = onDispose(() => {
        held.delete(file);
        fs.rmSync(file, { force: true });
      });
      return release;
    }
    // A holder that released between the failed create and this read leaves nothing to judge: try the create again.
    const found = read(file);
    if (found === null) continue;
    const verdict = found.holder === null ? "stale" : judge(file, found.holder);
    if (found.holder !== null && verdict !== "stale") {
      throw new UsageError(refusal(file, found.holder, verdict));
    }
    takeOver(file, found.text, found.holder);
  }
  throw new UsageError(
    `${file}: the lock could not be taken, because another command is taking it over; try again, or remove ${path.join(outDir, TAKEOVER_FILE)} if none is`,
  );
}
