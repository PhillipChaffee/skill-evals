import fs from "node:fs";
import path from "node:path";

const SKILL_FILE = /^skill\.md$/i;

/**
 * Finds the skill directories under a root, without going into one that was placed.
 * @param root - A directory that may not exist.
 * @param placed - The directories the run placed, as resolved paths.
 * @returns The directories that hold a SKILL.md and are not placed.
 */
function skillDirs(root: string, placed: Set<string>): string[] {
  if (placed.has(path.resolve(root)) || !fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && SKILL_FILE.test(e.name))) return [root];
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => skillDirs(path.join(root, entry.name), placed));
}

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
    Object.values(run.placed ?? {}).map((d) => path.resolve(d)),
  );
  return ["skills", "synced"]
    .flatMap((root) => skillDirs(path.join(config, root), placed))
    .map((dir) => `account skill ${path.basename(dir)}`);
}
