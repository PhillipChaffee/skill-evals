import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./scope.js";

/**
 * Compiles a glob to a regular expression that matches a whole relative posix path.
 * `*` matches any run of characters but `/`, `**` matches any run including `/` (and `**` followed by `/` also
 * matches no directory at all), `?` matches one character but `/`, and `{a,b}` matches either. A backslash makes the
 * next character literal.
 * @param glob - The glob.
 * @returns The anchored expression.
 * @throws {UsageError} When a `{` is never closed.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  let open = 0;
  for (let at = 0; at < glob.length; at++) {
    const char = glob.charAt(at);
    if (char === "*" && glob.charAt(at + 1) === "*") {
      at++;
      if (glob.charAt(at + 1) === "/") {
        at++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      open++;
      source += "(?:";
    } else if (char === "}" && open > 0) {
      open--;
      source += ")";
    } else if (char === "," && open > 0) {
      source += "|";
    } else {
      const literal = char === "\\" ? glob.charAt(++at) : char;
      source += literal.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
    }
  }
  if (open > 0) throw new UsageError(`unclosed "{" in the glob ${glob}`);
  return new RegExp(`^${source}$`);
}

/**
 * Makes a glob that matches exactly one path.
 * @param relative - A relative posix path, which may hold characters that a glob reads as syntax.
 * @returns The path with a backslash in front of each such character.
 */
export const literalGlob = (relative: string): string =>
  relative.replace(/[*?{}\\]/g, "\\$&");

const DEFAULT_LIMIT = 5000;

/**
 * Lists the paths under a directory that a glob matches. A link is listed when it matches, and never followed.
 * @param root - The directory to look in.
 * @param glob - Matched against each path relative to root, with `/` as the separator.
 * @param limit - The most paths to return.
 * @returns The matching files, directories and links, as sorted relative posix paths. A directory that cannot be read
 *   is skipped.
 * @throws {UsageError} When more than `limit` paths match, naming the glob.
 */
export function expandGlob(
  root: string,
  glob: string,
  limit = DEFAULT_LIMIT,
): string[] {
  const matcher = globToRegExp(glob);
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      if (matcher.test(relative)) {
        found.push(relative);
        if (found.length > limit) {
          throw new UsageError(
            `the glob "${glob}" matches more than ${String(limit)} paths in ${root}`,
          );
        }
      }
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${relative}/`);
    }
  };
  walk(root, "");
  return found.sort();
}
