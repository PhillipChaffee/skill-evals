import fs from "node:fs";
import path from "node:path";
import { requireLinksInside } from "./isolate.js";
import { UsageError } from "./scope.js";

/**
 * Finds a case's `workspace/` folder, and makes sure that no link in it can reach outside it.
 * @param dir - Where the folder would be.
 * @param file - The case file, for an error message.
 * @returns The folder, or null when there is none.
 * @throws {UsageError} Naming the first link whose target is absolute or leads outside the folder: a copy keeps links
 *   as they are, so the agent could write into the case through it.
 */
export function workspaceOf(dir: string, file: string): string | null {
  if (!fs.existsSync(dir)) return null;
  try {
    requireLinksInside(dir, "the workspace");
  } catch (error) {
    if (error instanceof UsageError) {
      throw new UsageError(`${file}: workspace/${error.message}`);
    }
    throw error;
  }
  return dir;
}

/**
 * Finds a case's `grader/` folder.
 * @param dir - The case's directory.
 * @param file - The case file, for an error message.
 * @returns The folder, or null when there is none.
 * @throws {UsageError} When `workspace/` holds a `grader/` folder: the agent would start with the held-out files.
 */
export function graderOf(dir: string, file: string): string | null {
  if (fs.existsSync(path.join(dir, "workspace", "grader"))) {
    throw new UsageError(
      `${file}: workspace/grader would give the agent the held-out files; move it beside prompt.md`,
    );
  }
  const grader = path.join(dir, "grader");
  return fs.existsSync(grader) ? grader : null;
}
