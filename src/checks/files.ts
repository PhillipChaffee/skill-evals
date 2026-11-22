import fs from "node:fs";
import { isGlob } from "../glob.js";
import type { Outcome, RuledCheck, Spec, Verdict } from "./index.js";
import { CHANGE_CHECKS } from "./file-changes.js";
import { TEXT_CHECKS } from "./file-text.js";
import { checkBounds } from "./bounds.js";
import { PASS } from "./rules.js";
import {
  find,
  pathsOf,
  shown,
  treeOf,
  unlisted,
  withUnlisted,
} from "./tree.js";
import type { Found, Tree } from "./tree.js";

const where = (check: RuledCheck): string => `"${check.path ?? ""}"`;

/**
 * Looks up what a check's path names.
 * @param check - A check with `path`, and perhaps `root`.
 * @param outcome - What the run left behind.
 * @param covered - Whether a plain path that names a directory means everything under it.
 * @returns The tree and what is at the path now.
 */
function lookup(
  check: RuledCheck,
  outcome: Outcome,
  covered = false,
): { tree: Tree; found: Found } {
  const tree = treeOf(check, outcome);
  return { tree, found: find(tree, check.path ?? "", covered) };
}

/**
 * Tells whether a file can be opened for reading.
 * @param real - Its real path.
 * @returns False when opening it fails.
 */
function readable(real: string): boolean {
  try {
    fs.closeSync(fs.openSync(real, "r"));
    return true;
  } catch {
    return false;
  }
}

const fileExists = (check: RuledCheck, outcome: Outcome): Verdict => {
  const { tree, found } = lookup(check, outcome);
  if (found.capped !== null) return { score: 0, reason: found.capped };
  const files = found.entries.filter((entry) => entry.kind === "file");
  if (files.length === 0) {
    return withUnlisted(
      {
        score: 0,
        reason: `no file matches ${where(check)} in the ${tree.name}`,
      },
      found,
    );
  }
  const open = files.filter((file) => readable(file.real));
  if (open.length === 0) {
    return {
      score: 0,
      reason: `${shown(files.map(({ path }) => path))} ${files.length === 1 ? "exists" : "exist"} but cannot be read`,
    };
  }
  if (!check.created) return PASS;
  const fresh = open.filter((file) => !tree.seed.has(file.path));
  return fresh.length > 0
    ? PASS
    : {
        score: 0,
        reason: `${shown(open.map(({ path }) => path))} ${open.length === 1 ? "was" : "were"} in the seed, so the agent did not create ${open.length === 1 ? "it" : "any of them"}`,
      };
};

const fileAbsent = (check: RuledCheck, outcome: Outcome): Verdict => {
  const { found } = lookup(check, outcome, true);
  if (found.capped !== null) return { score: 0, reason: found.capped };
  // A plain path that names a directory means its files, so the directory and its subdirectories are not "there".
  const files = !isGlob(check.path ?? "") && found.entries[0]?.kind === "dir";
  const there = found.entries
    .filter(({ kind }) => !files || kind !== "dir")
    .map(({ path }) => path);
  if (there.length > 0) {
    return {
      score: 0,
      reason: `present: ${shown(there)} matches ${where(check)}${unlisted(found)}`,
    };
  }
  return found.unreadable.length === 0
    ? PASS
    : {
        score: 0,
        reason: `cannot be shown absent${unlisted(found)}`,
      };
};

const fileCount = (check: RuledCheck, outcome: Outcome): Verdict => {
  const { found } = lookup(check, outcome, true);
  if (found.capped !== null) return { score: 0, reason: found.capped };
  const files = pathsOf(found, "file");
  const { min = 1, max = Infinity } = check;
  if (files.length >= min && files.length <= max) {
    const unsure = found.unreadable.length > 0 && max !== Infinity;
    return unsure
      ? withUnlisted(
          { score: 0, reason: "the count cannot be confirmed" },
          found,
        )
      : PASS;
  }
  const bound =
    files.length < min
      ? `fewer than min ${String(min)}`
      : `more than max ${String(max)}`;
  const list = files.length === 0 ? "" : `: ${shown(files)}`;
  return withUnlisted(
    {
      score: 0,
      reason: `${String(files.length)} ${files.length === 1 ? "file matches" : "files match"} ${where(check)}, ${bound}${list}`,
    },
    found,
  );
};

const dirExists = (check: RuledCheck, outcome: Outcome): Verdict => {
  const { tree, found } = lookup(check, outcome);
  if (found.capped !== null) return { score: 0, reason: found.capped };
  return pathsOf(found, "dir").length > 0
    ? PASS
    : withUnlisted(
        {
          score: 0,
          reason: `no directory matches ${where(check)} in the ${tree.name}`,
        },
        found,
      );
};

const ROOT = ["root"];

// The checks of the files the run left, in the workspace or in the home.
export const FILE_CHECKS = {
  file_exists: {
    fields: ["path"],
    optional: ["created", ...ROOT],
    scores:
      "A file exists at `path` and can be read; with `created`, one that the root did not hold before the run. A glob needs one matching file. A directory is not a file.",
    rule: fileExists,
  },
  ...TEXT_CHECKS,
  file_absent: {
    fields: ["path"],
    optional: ROOT,
    scores:
      "Nothing exists at `path`, whether a file, a directory or a link. A path that matches nothing scores 1, and so does one that leads nowhere: a dangling link, or a link that leaves the root. A directory that cannot be listed scores 0.",
    rule: fileAbsent,
  },
  ...CHANGE_CHECKS,
  file_count: {
    fields: ["path"],
    optional: ["min", "max", ...ROOT],
    scores:
      "The number of files that `path` matches is from `min` (default 1) to `max`. Directories are not counted. A plain path that names a directory, or ends in `/`, means every file under it.",
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
