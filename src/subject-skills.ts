import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./scope.js";

const hasSkillFile = (dir: string): boolean =>
  fs.existsSync(path.join(dir, "SKILL.md"));

/**
 * Finds every `<dir>/<name>/SKILL.md` and `<dir>/skills/<name>/SKILL.md`, and dir itself when it holds a SKILL.md.
 * @param dir - The folder to search, one level deep.
 * @param ownName - The skill name of dir itself.
 * @param shown - What an error message calls dir.
 * @returns Skill name to its directory, in name order.
 * @throws {UsageError} When two skills share a name.
 */
export function findSkills(
  dir: string,
  ownName: string,
  shown: string,
): Record<string, string> {
  const found: [string, string][] = hasSkillFile(dir) ? [[ownName, dir]] : [];
  for (const parent of [dir, path.join(dir, "skills")]) {
    if (!fs.existsSync(parent)) continue;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const skillDir = path.join(parent, entry.name);
      if (entry.isDirectory() && hasSkillFile(skillDir)) {
        found.push([entry.name, skillDir]);
      }
    }
  }
  const names = found.map(([name]) => name);
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice) throw new UsageError(`${shown} holds two skills named "${twice}"`);
  return Object.fromEntries(found.sort(([x], [y]) => x.localeCompare(y)));
}
