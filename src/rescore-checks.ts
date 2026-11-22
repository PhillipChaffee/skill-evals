import { matchChecks } from "./check-match.js";
import type { Check } from "./checks/index.js";
import { COMMAND_CHECKS } from "./checks/command.js";
import { FILE_CHECKS } from "./checks/files.js";
import type { CheckResult } from "./run-plan.js";

/** Why a check of a stored run keeps its old score, or has none. */
export const NO_ARCHIVE = "not re-scored: no workspace archive";

/**
 * Tells whether a check reads the workspace or the home.
 * @param check - Any check of a case.
 * @returns True for a file check, a `command` check, and a judged or decision check that sees `files`.
 */
const needsFiles = (check: Check): boolean =>
  Object.hasOwn(FILE_CHECKS, check.type) ||
  Object.hasOwn(COMMAND_CHECKS, check.type) ||
  (check.sees?.includes("files") ?? false);

/** What to do with each check of the current case for a run that has no archive. */
export interface Split {
  /** The checks to score again, in case order. */
  run: Check[];
  /** For each check of the case: its place in `run`, or the result it keeps. */
  parts: ({ at: number } | { kept: CheckResult })[];
}

/**
 * Decides which checks of the current case can be scored again for a run.
 * @param old - The results that the run was stored with.
 * @param current - The checks of the case as it is now.
 * @param archived - Whether the run has an archive of its workspace and home.
 * @returns With an archive, every check is scored again. Without one, a check that needs the workspace or the home
 *   keeps the score of its match among the old results, or has no score when it is new, and says why.
 */
export function splitChecks(
  old: CheckResult[],
  current: Check[],
  archived: boolean,
): Split {
  const matches = matchChecks(old, current);
  const run: Check[] = [];
  const parts = current.map((check, index): Split["parts"][number] => {
    if (archived || !needsFiles(check)) {
      run.push(check);
      return { at: run.length - 1 };
    }
    const before = matches[index];
    const score =
      before === null || before === undefined
        ? null
        : (old[before]?.score ?? null);
    const kept: CheckResult = { ...check, score, reason: NO_ARCHIVE };
    return { kept };
  });
  return { run, parts };
}
