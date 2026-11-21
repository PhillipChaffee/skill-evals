import type { Outcome, RuledCheck, Spec, Verdict } from "./index.js";
import { CHANGE_CHECKS } from "./file-changes.js";
import { TEXT_CHECKS } from "./file-text.js";
import { checkBounds } from "./bounds.js";
import { PASS } from "./rules.js";
import { find, pathsOf, shown, treeOf } from "./tree.js";
import type { Found, Tree } from "./tree.js";

const where = (check: RuledCheck): string => `"${check.path ?? ""}"`;

/**
 * Looks up what a check's path names.
 * @param check - A check with `path`, and perhaps `root`.
 * @param outcome - What the run left behind.
 * @returns The tree and what is at the path now.
 */
function lookup(
  check: RuledCheck,
  outcome: Outcome,
): { tree: Tree; found: Found } {
  const tree = treeOf(check, outcome);
  return { tree, found: find(tree, check.path ?? "") };
}

const fileExists = (check: RuledCheck, outcome: Outcome): Verdict => {
  const { tree, found } = lookup(check, outcome);
  if (found.capped !== null) return { score: 0, reason: found.capped };
  const files = pathsOf(found, "file");
  if (files.length === 0) {
    return {
      score: 0,
      reason: `no file matches ${where(check)} in the ${tree.name}`,
    };
  }
  if (!check.created) return PASS;
  const fresh = files.filter((file) => !tree.seed.has(file));
  return fresh.length > 0
    ? PASS
    : {
        score: 0,
        reason: `${shown(files)} already in the seed, so the agent did not create ${files.length === 1 ? "it" : "any of them"}`,
      };
};

const fileAbsent = (check: RuledCheck, outcome: Outcome): Verdict => {
  const { found } = lookup(check, outcome);
  if (found.capped !== null) return { score: 0, reason: found.capped };
  const there = found.entries.map(({ path }) => path);
  return there.length === 0
    ? PASS
    : { score: 0, reason: `present: ${shown(there)} matches ${where(check)}` };
};

const fileCount = (check: RuledCheck, outcome: Outcome): Verdict => {
  const { found } = lookup(check, outcome);
  if (found.capped !== null) return { score: 0, reason: found.capped };
  const files = pathsOf(found, "file");
  const { min = 1, max = Infinity } = check;
  if (files.length >= min && files.length <= max) return PASS;
  const bound =
    files.length < min
      ? `fewer than min ${String(min)}`
      : `more than max ${String(max)}`;
  const list = files.length === 0 ? "" : `: ${shown(files)}`;
  return {
    score: 0,
    reason: `${String(files.length)} ${files.length === 1 ? "file matches" : "files match"} ${where(check)}, ${bound}${list}`,
  };
};

const dirExists = (check: RuledCheck, outcome: Outcome): Verdict => {
  const { tree, found } = lookup(check, outcome);
  if (found.capped !== null) return { score: 0, reason: found.capped };
  return pathsOf(found, "dir").length > 0
    ? PASS
    : {
        score: 0,
        reason: `no directory matches ${where(check)} in the ${tree.name}`,
      };
};

const ROOT = ["root"];

// The checks of the files the run left, in the workspace or in the home.
export const FILE_CHECKS = {
  file_exists: {
    fields: ["path"],
    optional: ["created", ...ROOT],
    scores:
      "A file exists at `path`; with `created`, one that the workspace did not hold before the run. A glob needs one matching file. A directory is not a file.",
    rule: fileExists,
  },
  ...TEXT_CHECKS,
  file_absent: {
    fields: ["path"],
    optional: ROOT,
    scores:
      "Nothing exists at `path`, whether a file, a directory or a link. A path that matches nothing scores 1.",
    rule: fileAbsent,
  },
  ...CHANGE_CHECKS,
  file_count: {
    fields: ["path"],
    optional: ["min", "max", ...ROOT],
    scores:
      "The number of files that `path` matches is from `min` (default 1) to `max`. Directories are not counted.",
    validate: checkBounds,
    rule: fileCount,
  },
  dir_exists: {
    fields: ["path"],
    optional: ROOT,
    scores:
      "A directory exists at `path`. A file or a link to one does not count.",
    rule: dirExists,
  },
} satisfies Record<string, Spec>;
