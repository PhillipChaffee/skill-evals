import path from "node:path";
import { globToRegExp, isGlob } from "../glob.js";
import { messageOf } from "../scope.js";

/**
 * Finds what is wrong with the `path` of a check.
 * @param file - The path or glob.
 * @returns Why it cannot be used, or null. A path may not be absolute or climb out with `..`, and a glob must
 *   compile.
 */
export function pathProblem(file: string): string | null {
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
    return `path must stay inside the workspace: ${file}`;
  }
  if (!isGlob(file)) return null;
  try {
    globToRegExp(file);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}
