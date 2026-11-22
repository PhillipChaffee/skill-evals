import fs from "node:fs";
import path from "node:path";
import { UsageError, onDispose } from "./scope.js";

const LOCK_FILE = ".lock";

/**
 * Tells whether a process is alive.
 * @param pid - A process id.
 * @returns False when no such process exists or the text was no process id; a process that this user may not signal is alive.
 */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Takes the lock of an output directory, so that two commands never write the same results.
 * @param outDir - The output directory, which exists.
 * @returns Releases the lock. It also runs when the process exits, and a second call does nothing.
 * @throws {UsageError} When another live process holds the lock. A lock of a process that is gone is taken over, with
 *   a warning.
 */
export function lockDir(outDir: string): () => void {
  const file = path.join(outDir, LOCK_FILE);
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx" });
  } catch {
    const holder = Number.parseInt(fs.readFileSync(file, "utf8"), 10);
    if (alive(holder)) {
      throw new UsageError(
        `${outDir} is in use by process ${String(holder)}; wait for it, or choose another --out`,
      );
    }
    console.error(
      `skill-evals: warning: took over the lock of ${outDir} from process ${String(holder)}, which is gone`,
    );
    fs.writeFileSync(file, String(process.pid));
  }
  return onDispose(() => {
    fs.rmSync(file, { force: true });
  });
}
