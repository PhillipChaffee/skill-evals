import type { ChangedFiles } from "../snapshot.js";
import type { Outcome, RuledCheck, Spec, Verdict } from "./index.js";
import { PASS } from "./rules.js";
import { pathProblem } from "./path-problem.js";
import type { Tree } from "./tree.js";
import { mayHold, shown, treeOf, treeScope } from "./tree.js";
import { UsageError } from "../scope.js";

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
): { changes: Change[]; tree: Tree } {
  const whole = treeOf(check, outcome);
  // A check of one turn reads what that turn changed; loading keeps `root: "home"` out of such a check.
  const tree =
    outcome.turn && whole.name === "workspace"
      ? { ...whole, changed: outcome.turn.changed }
      : whole;
  const inside = (path: string): boolean =>
    tree.unlisted.some((dir) => path.startsWith(`${dir}/`));
  // A directory that cannot be listed shows as a changed entry and as deleted files. Neither is a change.
  const seen = changesOf(tree.changed).filter(
    ({ path, how }) =>
      !tree.unlisted.includes(path) && !(how === "deleted" && inside(path)),
  );
  return { changes: seen, tree };
}

/**
 * Says which directories that cannot be listed could hold a match.
 * @param tree - The tree the check looks at.
 * @param patterns - The paths or globs of the check.
 * @returns A clause that names them, "" when none could.
 */
function blind(tree: Tree, patterns: string[]): string {
  const dirs = [
    ...new Set(patterns.flatMap((glob) => mayHold(tree.unlisted, glob))),
  ];
  return dirs.length === 0 ? "" : `${shown(dirs)} cannot be listed`;
}

/**
 * Scores whether the agent left the matching files alone.
 * @param check - A check with `path`.
 * @param outcome - What the run left behind.
 * @returns 1 when no path that the glob matches was created, modified or deleted. That includes the case where the
 *   seed and the tree both lack a match.
 */
function unchanged(check: RuledCheck, outcome: Outcome): Verdict {
  const { changes, tree } = changesIn(check, outcome);
  const test = treeScope(tree, check.path ?? "");
  const hit = changes.filter(({ path }) => test(path));
  const dark = blind(tree, [check.path ?? ""]);
  if (hit.length === 0 && dark === "") return PASS;
  const parts = [hit.length > 0 ? `changed: ${named(hit)}` : "", dark];
  return { score: 0, reason: parts.filter(Boolean).join("; ") };
}

/**
 * Scores whether the agent changed the matching files.
 * @param check - A check with `path`.
 * @param outcome - What the run left behind.
 * @returns 1 when a path that the glob matches was created, modified or deleted.
 */
function changed(check: RuledCheck, outcome: Outcome): Verdict {
  const { changes, tree } = changesIn(check, outcome);
  const test = treeScope(tree, check.path ?? "");
  if (changes.some(({ path }) => test(path))) return PASS;
  const dark = blind(tree, [check.path ?? ""]);
  return {
    score: 0,
    reason: `nothing matching "${check.path ?? ""}" was created, modified or deleted${dark === "" ? "" : `; ${dark}`}`,
  };
}

/**
 * Scores whether every change is in the allowed set.
 * @param check - A check with `allow`, and perhaps `ignore`.
 * @param outcome - What the run left behind.
 * @returns 1 when each created, modified or deleted path, once the ignored ones are left out, matches `allow`.
 */
function changedOnly(check: RuledCheck, outcome: Outcome): Verdict {
  const { changes, tree } = changesIn(check, outcome);
  const allowed = (check.allow ?? []).map((glob) => treeScope(tree, glob));
  const ignored = (check.ignore ?? []).map((glob) => treeScope(tree, glob));
  const outside = changes.filter(
    ({ path }) =>
      !ignored.some((test) => test(path)) &&
      !allowed.some((test) => test(path)),
  );
  const covered = (dir: string): boolean =>
    [...allowed, ...ignored].some((test) => test(`${dir}/x`));
  const dark = tree.unlisted.filter((dir) => !covered(dir));
  if (outside.length === 0 && dark.length === 0) return PASS;
  const parts = [
    outside.length > 0 ? `changed outside allow: ${named(outside)}` : "",
    dark.length > 0 ? `${shown(dark)} cannot be listed` : "",
  ];
  return { score: 0, reason: parts.filter(Boolean).join("; ") };
}

/**
 * Checks that every path of `allow` and `ignore` is usable as a `path` is.
 * @param given - The fields that are set.
 * @param where - Names the file and the check in an error message.
 * @throws {UsageError} For a path that is absolute, climbs with `..`, or is a glob with an unclosed `{`.
 */
function checkGlobs(given: Record<string, unknown>, where: string): void {
  for (const key of ["allow", "ignore"]) {
    for (const glob of (given[key] as string[] | undefined) ?? []) {
      const problem = pathProblem(glob);
      if (problem) throw new UsageError(`${where}: "${key}": ${problem}`);
    }
  }
}

// The checks of what the run changed in its files.
export const CHANGE_CHECKS = {
  file_unchanged: {
    fields: ["path"],
    optional: ["root"],
    scores:
      "No file at `path` was created, modified or deleted by the run. A path that matches no file in the seed and none now scores 1. A directory that could not be listed, and could hold a match, scores 0.",
    note: "A plain path that names a directory, or ends in `/`, covers every file under it. A mode-only change is not a change, and a link is matched by its own path, never followed.",
    rule: unchanged,
  },
  file_changed: {
    fields: ["path"],
    optional: ["root"],
    scores:
      "A file at `path` was created, modified or deleted by the run. A path that matches no file scores 0, and the reason names a directory that could not be listed and could have held one.",
    rule: changed,
  },
  files_changed_only: {
    fields: ["allow"],
    optional: ["ignore", "root"],
    scores:
      "Every path the run created, modified or deleted, except the ones `ignore` names, matches a path or glob of `allow`. A plain directory path covers everything under it. A directory that could not be listed scores 0, unless an `allow` or `ignore` path covers all of it.",
    validate: checkGlobs,
    rule: changedOnly,
  },
} satisfies Record<string, Spec>;
