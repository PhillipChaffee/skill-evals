import type { ChangedFiles } from "../snapshot.js";
import type { Outcome, RuledCheck, Spec, Verdict } from "./index.js";
import { PASS } from "./rules.js";
import { pathTest, shown, treeOf } from "./tree.js";
import { UsageError } from "../scope.js";
import { globToRegExp } from "../glob.js";

/** A changed path with how it changed. */
interface Change {
  path: string;
  how: "created" | "modified" | "deleted";
}

/**
 * Lists every change in one list.
 * @param changed - What the run changed in a tree.
 * @returns The created paths, then the modified, then the deleted, each with how it changed.
 */
const changesOf = (changed: ChangedFiles): Change[] => [
  ...changed.created.map((path): Change => ({ path, how: "created" })),
  ...changed.modified.map((path): Change => ({ path, how: "modified" })),
  ...changed.deleted.map((path): Change => ({ path, how: "deleted" })),
];

const named = (changes: Change[]): string =>
  shown(changes.map(({ path, how }) => `${how} ${path}`));

/**
 * Takes the changes of the tree a check names.
 * @param check - A check, whose `root` says which tree.
 * @param outcome - What the run left behind.
 * @returns The changes, and the tree's name.
 */
function changesIn(
  check: RuledCheck,
  outcome: Outcome,
): { changes: Change[]; where: string } {
  const tree = treeOf(check, outcome);
  return { changes: changesOf(tree.changed), where: tree.name };
}

/**
 * Scores whether the agent left the matching files alone.
 * @param check - A check with `path`.
 * @param outcome - What the run left behind.
 * @returns 1 when no path that the glob matches was created, modified or deleted. That includes the case where the
 *   seed and the tree both lack a match.
 */
function unchanged(check: RuledCheck, outcome: Outcome): Verdict {
  const test = pathTest(check.path ?? "");
  const { changes } = changesIn(check, outcome);
  const hit = changes.filter(({ path }) => test(path));
  return hit.length === 0
    ? PASS
    : { score: 0, reason: `changed: ${named(hit)}` };
}

/**
 * Scores whether the agent changed the matching files.
 * @param check - A check with `path`.
 * @param outcome - What the run left behind.
 * @returns 1 when a path that the glob matches was created, modified or deleted.
 */
function changed(check: RuledCheck, outcome: Outcome): Verdict {
  const test = pathTest(check.path ?? "");
  const { changes } = changesIn(check, outcome);
  return changes.some(({ path }) => test(path))
    ? PASS
    : {
        score: 0,
        reason: `nothing matching "${check.path ?? ""}" was created, modified or deleted`,
      };
}

/**
 * Scores whether every change is in the allowed set.
 * @param check - A check with `allow`, and perhaps `ignore`.
 * @param outcome - What the run left behind.
 * @returns 1 when each created, modified or deleted path, once the ignored ones are left out, matches `allow`.
 */
function changedOnly(check: RuledCheck, outcome: Outcome): Verdict {
  const allowed = (check.allow ?? []).map(pathTest);
  const ignored = (check.ignore ?? []).map(pathTest);
  const { changes } = changesIn(check, outcome);
  const outside = changes.filter(
    ({ path }) =>
      !ignored.some((test) => test(path)) &&
      !allowed.some((test) => test(path)),
  );
  return outside.length === 0
    ? PASS
    : { score: 0, reason: `changed outside allow: ${named(outside)}` };
}

/**
 * Checks that every glob of `allow` and `ignore` compiles and stays inside the tree.
 * @param given - The fields that are set.
 * @param where - Names the file and the check in an error message.
 * @throws {UsageError} For a glob that is absolute, climbs with `..`, or has an unclosed `{`.
 */
function checkGlobs(given: Record<string, unknown>, where: string): void {
  for (const key of ["allow", "ignore"]) {
    for (const glob of (given[key] as string[] | undefined) ?? []) {
      if (glob.startsWith("/") || glob.split("/").includes("..")) {
        throw new UsageError(
          `${where}: "${key}" globs must stay inside the root: ${glob}`,
        );
      }
      globToRegExp(glob);
    }
  }
}

// The checks of what the run changed in its files.
export const CHANGE_CHECKS = {
  file_unchanged: {
    fields: ["path"],
    optional: ["root"],
    scores:
      "No file at `path` was created, modified or deleted by the run. A path that matches no file in the seed and none now scores 1.",
    note: "A directory is not a file, so write `dir/**` to cover what is under it.",
    rule: unchanged,
  },
  file_changed: {
    fields: ["path"],
    optional: ["root"],
    scores:
      "A file at `path` was created, modified or deleted by the run. A path that matches no file scores 0.",
    rule: changed,
  },
  files_changed_only: {
    fields: ["allow"],
    optional: ["ignore", "root"],
    scores:
      "Every path the run created, modified or deleted, except the ones `ignore` names, matches a glob of `allow`.",
    validate: checkGlobs,
    rule: changedOnly,
  },
} satisfies Record<string, Spec>;
