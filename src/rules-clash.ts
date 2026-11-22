import fs from "node:fs";
import path from "node:path";
import type { Case } from "./cases.js";
import type { Harness, RulesFile } from "./harnesses/shared.js";
import { UsageError } from "./scope.js";
import type { Subject } from "./subject.js";
import { rulesFilesOf } from "./subject-rules.js";

/**
 * Finds the file of a case that a rule would be installed over.
 * @param caseDef - The case, whose shared fixtures, `workspace/` and `home/` the run copies first.
 * @param target - Where an adapter puts a rule.
 * @param target.root - The run's workspace or home.
 * @param target.path - The path under that root.
 * @returns The path of the case's file at that place, or null when the case has none.
 */
function takenBy(
  caseDef: Case,
  target: { root: "workspace" | "home"; path: string },
): string | null {
  const dirs =
    target.root === "home"
      ? [caseDef.homeDir]
      : [...caseDef.fixtureDirs, caseDef.workspaceDir];
  for (const dir of dirs) {
    if (dir === null) continue;
    const file = path.join(dir, target.path);
    try {
      fs.lstatSync(file);
      return file;
    } catch {
      // Nothing at that place in this directory.
    }
  }
  return null;
}

/**
 * Refuses a case whose files a subject's rules would be installed over. A rule is never installed over a file, so the
 * run would fail; the command says so before any run starts.
 * @param harnesses - The harnesses of the command, with the cases each runs.
 * @param subjects - The command's resolved subjects.
 * @throws {UsageError} Naming the rule or instruction file, the harness and the place it installs to, and the case's
 *   file that is already there.
 */
export function requireNoRulesClash(
  harnesses: { harness: Harness; cases: Case[] }[],
  subjects: Subject[],
): void {
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
          throw new UsageError(
            `case ${caseDef.id}: ${taken} clashes with the rule ${rule} of ${subject.spec}, which ${harness.id} installs as ${target.root}/${target.path}; rename one of them`,
          );
        });
      }
    }
  }
}
