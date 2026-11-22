import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./scope.js";

/**
 * Tells whether a path is strictly inside a directory.
 * @param root - The directory.
 * @param target - The path.
 * @returns True when `target` is below `root` and is not `root` itself.
 */
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Reads the prompt file of a turn. The path is relative to the case's directory and follows the rules of the case's
 * other files: it may not leave the case, a link must lead to a file inside the case, and it may not be in `grader/`,
 * whose files the agent must never see.
 * @param dir - The case's directory.
 * @param named - The path as the case file writes it.
 * @param where - Names the case file and the turn, for an error message.
 * @returns The text of the file, trimmed.
 * @throws {UsageError} When the path leaves the case, does not exist, is no file, is in `grader/`, or the file is empty.
 */
export function promptFileOf(
  dir: string,
  named: string,
  where: string,
): string {
  const fail = (problem: string): UsageError =>
    new UsageError(`${where}: prompt ${named} ${problem}`);
  const resolved = path.resolve(dir, named);
  if (!inside(dir, resolved)) throw fail("must stay inside the case");
  if (!fs.existsSync(resolved)) throw fail("does not exist");
  const real = fs.realpathSync(resolved);
  const root = fs.realpathSync(dir);
  if (!inside(root, real)) throw fail("must stay inside the case");
  if (!fs.statSync(real).isFile()) throw fail("is not a file");
  if (path.relative(root, real).split(path.sep)[0] === "grader") {
    throw fail("is in grader/, whose files the agent must not see");
  }
  const text = fs.readFileSync(real, "utf8").trim();
  if (text === "") throw fail("is empty");
  return text;
}
