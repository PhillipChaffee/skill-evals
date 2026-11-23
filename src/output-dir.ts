import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./approval.js";

// Bytes of randomness after the time in a default output directory's name, so two commands in one second differ.
const RANDOM_BYTES = 4;

/**
 * Where a command's results go.
 * @param requested - The directory the user asked for, created when missing. Absent means a new directory under the
 *   state directory.
 * @param cwd - What a relative `requested` resolves against.
 * @param env - Where the state directory is read from. Default: the process's environment.
 * @returns An absolute path to a directory that exists and that nothing removes afterwards. The default is
 *   `<state dir>/runs/<time>-<random>`, outside the system's temp directory, which an agent's tools can list.
 */
export function outputDir(
  requested: string | undefined,
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!requested) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const random = randomBytes(RANDOM_BYTES).toString("hex");
    const dir = path.resolve(stateDir(env), "runs", `${stamp}-${random}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = path.resolve(cwd, requested);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
