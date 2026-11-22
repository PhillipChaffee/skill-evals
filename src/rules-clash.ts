import fs from "node:fs";
import path from "node:path";
import type { Case } from "./cases.js";
import type { Harness, RulesFile, RulesTarget } from "./harnesses/shared.js";
import { UsageError } from "./scope.js";
import type { Subject } from "./subject.js";
import { rulesFilesOf } from "./subject-rules.js";

/** A file of a case that a subject's rules would be installed over, or into the directory of. */
export interface Clash {
  caseId: string;
  /** What is wrong and which file to change. */
  text: string;
}

/**
 * Tells whether anything is at a path.
 * @param file - A path.
 * @returns True when the path is a file, a directory or a link; a link is not followed.
 */
function present(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds what a directory of a case has at a place.
 * @param dir - A directory of the case.
 * @param place - A path under it.
 * @param whole - True when the place is an area: any file inside it counts, and the first is named.
 * @returns The path of the file in the way; null when there is none.
 */
function inWay(dir: string, place: string, whole: boolean): string | null {
  const file = path.join(dir, place);
  if (!present(file)) return null;
  if (!whole) return file;
  const [inside] = fs.readdirSync(file);
  return inside === undefined ? null : path.join(file, inside);
}

/**
 * Finds the file of a case that a rule would be installed over.
 * @param caseDef - The case, whose shared fixtures, `workspace/` and `home/` the run copies first.
 * @param target - Where an adapter puts a rule; its `area` is the directory that holds the rules, which the case may
 *   not put a file in either.
 * @returns The path of the case's file at that place, or in that directory; null when the case has none.
 */
function takenBy(caseDef: Case, target: RulesTarget): string | null {
  const dirs = (
    target.root === "home"
      ? [caseDef.homeDir]
      : [...caseDef.fixtureDirs, caseDef.workspaceDir]
  ).filter((dir) => dir !== null);
  for (const dir of dirs) {
    const found =
      inWay(dir, target.path, false) ??
      (target.area === undefined ? null : inWay(dir, target.area, true));
    if (found !== null) return found;
  }
  return null;
}

/**
 * Finds every file of a case that a subject's rules would be installed over.
 * @param harnesses - The harnesses of the command, with the cases each runs.
 * @param subjects - The command's resolved subjects.
 * @returns One clash for each case, harness and rule that collide; none when the rules go in cleanly. A rule is never
 *   installed over a file, so the run would fail.
 */
export function rulesClashes(
  harnesses: { harness: Harness; cases: Case[] }[],
  subjects: Subject[],
): Clash[] {
  const found: Clash[] = [];
  for (const subject of subjects) {
    if (subject.rules === null || subject.exported === null) continue;
    const files: RulesFile[] = rulesFilesOf(subject.rules, subject.exported);
    for (const { harness, cases } of harnesses) {
      if (harness.rulesTargets === undefined) continue;
      const targets = harness.rulesTargets(files);
      for (const caseDef of cases) {
        targets.forEach((target, index) => {
          const taken = takenBy(caseDef, target);
          if (taken === null) return;
          const rule = files[index]?.relative ?? target.path;
          found.push({
            caseId: caseDef.id,
            text: `${taken} clashes with the rule ${rule} of ${subject.spec}, which ${harness.id} installs as ${target.root}/${target.path}; rename or remove that file of the case, or change "rules" or "instructionFile" of the subject`,
          });
        });
      }
    }
  }
  return found;
}

/**
 * Refuses a case whose files a subject's rules would be installed over, before any run starts.
 * @param harnesses - The harnesses of the command, with the cases each runs.
 * @param subjects - The command's resolved subjects.
 * @throws {UsageError} Naming the case, the case's file that is in the way, the rule, the harness and the place, and
 *   which file to change.
 */
export function requireNoRulesClash(
  harnesses: { harness: Harness; cases: Case[] }[],
  subjects: Subject[],
): void {
  const [first] = rulesClashes(harnesses, subjects);
  if (first) throw new UsageError(`case ${first.caseId}: ${first.text}`);
}
