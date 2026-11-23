import fs from "node:fs";
import path from "node:path";

const SKILL_FILE = /^skill\.md$/i;

/**
 * Tells what an entry of a directory is, following a symbolic link.
 * @param dir - The directory.
 * @param entry - One of its entries.
 * @returns "file", "dir", or null for anything else and for a link that leads nowhere.
 */
function kindOf(dir: string, entry: fs.Dirent): "file" | "dir" | null {
  let info: fs.Stats | fs.Dirent = entry;
  if (entry.isSymbolicLink()) {
    try {
      info = fs.statSync(path.join(dir, entry.name));
    } catch {
      return null;
    }
  }
  return info.isFile() ? "file" : info.isDirectory() ? "dir" : null;
}

/**
 * Finds the skill directories under a root, without going into one that was placed. A symbolic link to a directory or to
 * a SKILL.md counts as what it leads to, since the harness follows it; each real directory is entered once.
 * @param root - A directory that may not exist.
 * @param placed - The directories the run placed, as resolved and as real paths.
 * @param seen - The real paths entered so far.
 * @returns The directories that hold a SKILL.md and are not placed.
 */
function skillDirs(
  root: string,
  placed: Set<string>,
  seen = new Set<string>(),
): string[] {
  if (placed.has(path.resolve(root)) || !fs.existsSync(root)) return [];
  const real = fs.realpathSync(root);
  if (placed.has(real) || seen.has(real)) return [];
  seen.add(real);
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const kinds = entries.map((entry) => ({ entry, kind: kindOf(root, entry) }));
  if (
    kinds.some(
      ({ entry, kind }) => kind === "file" && SKILL_FILE.test(entry.name),
    )
  ) {
    return [root];
  }
  return kinds
    .filter(({ kind }) => kind === "dir")
    .flatMap(({ entry }) =>
      skillDirs(path.join(root, entry.name), placed, seen),
    );
}

/**
 * Resolves a path through its links.
 * @param dir - A path, which need not exist.
 * @returns Its real path; the path itself when it does not exist.
 */
const realOr = (dir: string): string => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
};

/**
 * Names the skills that an account synced into the run's config directory, which the init event lists as bare names.
 * @param run - The run's home, and the skill directories it placed.
 * @param run.home - The throwaway home.
 * @param run.placed - Skill name to the directory the adapter placed.
 * @returns `account skill <name>` for every skill directory under the skills and synced roots that is not placed.
 */
export function strayskills(run: {
  home: string;
  placed: Record<string, string> | undefined;
}): string[] {
  const config = path.join(run.home, ".claude");
  const placed = new Set(
    Object.values(run.placed ?? {}).flatMap((d) => [
      path.resolve(d),
      realOr(d),
    ]),
  );
  return ["skills", "synced"]
    .flatMap((root) => skillDirs(path.join(config, root), placed))
    .map((dir) => `account skill ${path.basename(dir)}`);
}
