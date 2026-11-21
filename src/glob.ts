import { UsageError } from "./scope.js";
import { walkTree } from "./walk.js";

/**
 * Translates the star at a position of a glob.
 * @param glob - The whole glob.
 * @param at - The position of a `*` in it.
 * @returns The regular expression for it, and how many characters it took: `*` stays within a directory, `**` goes
 *   across directories, and `**` followed by `/` also matches no directory at all.
 */
function star(glob: string, at: number): { source: string; length: number } {
  if (glob.charAt(at + 1) !== "*") return { source: "[^/]*", length: 1 };
  if (glob.charAt(at + DOUBLE_STAR) === "/")
    return { source: "(?:.*/)?", length: DOUBLE_STAR_SLASH };
  return { source: ".*", length: DOUBLE_STAR };
}

const DOUBLE_STAR = 2;
const DOUBLE_STAR_SLASH = 3;
const ESCAPED = 2;
const literal = (char: string): string =>
  char.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");

/**
 * Compiles a glob to a regular expression that matches a whole relative posix path.
 * `*` matches any run of characters but `/`, `**` matches any run including `/`, `?` matches one character but `/`,
 * and `{a,b}` matches either. A backslash makes the next character literal.
 * @param glob - The pattern to compile.
 * @returns An expression that must match the whole path.
 * @throws {UsageError} When a `{` is never closed.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  let open = 0;
  let at = 0;
  while (at < glob.length) {
    const char = glob.charAt(at);
    let part = literal(char);
    let length = 1;
    if (char === "*") ({ source: part, length } = star(glob, at));
    else if (char === "?") part = "[^/]";
    else if (char === "{") [part, open] = ["(?:", open + 1];
    else if (char === "}" && open > 0) [part, open] = [")", open - 1];
    else if (char === "," && open > 0) part = "|";
    else if (char === "\\")
      [part, length] = [literal(glob.charAt(at + 1)), ESCAPED];
    source += part;
    at += length;
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
  walkTree(root, {
    unreadable: () => undefined,
    visit: ({ relative }) => {
      if (!matcher.test(relative)) return undefined;
      found.push(relative);
      if (found.length > limit) {
        throw new UsageError(
          `the glob "${glob}" matches more than ${String(limit)} paths in ${root}`,
        );
      }
      return undefined;
    },
  });
  return found.sort();
}

/**
 * Takes the part of a case glob that names the case, before the `@` that starts a variant's name.
 * @param glob - A glob over case ids.
 * @returns The part before the first `@`, or the whole glob when it has none. A part that is empty, or that holds a
 *   brace the `@` splits, names nothing certain, so it is `**`.
 */
export function baseGlobOf(glob: string): string {
  const at = glob.indexOf("@");
  if (at < 0) return glob;
  const part = glob.slice(0, at);
  const braces = (char: string) => part.split(char).length;
  return part === "" || braces("{") !== braces("}") ? "**" : part;
}

/**
 * Tells whether a case glob could match a variant's id without matching its case's path.
 * @param glob - A glob over case ids.
 * @returns True for a glob with a wildcard and no literal `@`, such as `to*lite`, which matches `tool@lite`.
 */
export const mayNameVariant = (glob: string): boolean =>
  !glob.includes("@") && /[*?{]/.test(glob);

/**
 * Takes the characters that every match of a glob starts with.
 * @param glob - A glob.
 * @returns The text before the first `*`, `?`, `{` or `\`, where the glob's syntax starts.
 */
export const literalPrefix = (glob: string): string =>
  glob.split(/[*?{\\]/)[0] ?? "";

/**
 * Tells whether a loose glob could match a variant of a case.
 * @param glob - A glob over case ids.
 * @param base - The case's path.
 * @returns True when `mayNameVariant` holds and the case's path starts with the glob's literal prefix. A variant's id
 *   is the path, an `@` and a name, and the glob has no `@`, so its prefix must lie within the path.
 */
export const mayReachVariantOf = (glob: string, base: string): boolean =>
  mayNameVariant(glob) && base.startsWith(literalPrefix(glob));
