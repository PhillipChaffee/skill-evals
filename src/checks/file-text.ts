import fs from "node:fs";
import { valueOf } from "./defaults.js";
import { countLines } from "../lines.js";
import type { Outcome, RuledCheck, Spec, Verdict } from "./index.js";
import { PASS, regex } from "./rules.js";
import { checkBounds } from "./bounds.js";
import { find, shown, treeOf, withUnlisted } from "./tree.js";

// Five mebibytes.
const PATTERN_CAP = 5_242_880;
const TOO_BIG = "file is larger than the 5 MB pattern cap";

/** What one file gave: whether it passes, and what to say beside its path when that is more than the path. */
interface Result {
  path: string;
  pass: boolean;
  note?: string;
}

/** How a check looks at the text of the files that its path names. */
interface TextRule {
  /** Whether a plain path that names a directory means every file under it. */
  cover: boolean;
  /** Whether a directory that cannot be listed scores 0: the check says that nothing is there. */
  closed: boolean;
  /** What the check does when the path matches no file. */
  none: (check: RuledCheck, where: string) => Verdict;
  /** The quantifier when the check names none; `file_lines` has no quantifier and always needs every file. */
  quantifier: (check: RuledCheck) => "any" | "all";
  /** Judges the text of one file. */
  test: (
    check: RuledCheck,
  ) => (text: string) => { pass: boolean; note?: string };
  /** Says what failed, given the files that did not pass. */
  failed: (check: RuledCheck, quantifier: "any" | "all") => string;
}

/**
 * Reads a file as text, within the cap.
 * @param real - The file's real path.
 * @returns The text, decoded as UTF-8 with replacement characters, or the problem that kept it from being read.
 */
function readText(real: string): { text: string } | { problem: string } {
  try {
    if (fs.statSync(real).size > PATTERN_CAP) return { problem: TOO_BIG };
    return { text: fs.readFileSync(real).toString("utf8") };
  } catch {
    return { problem: "unreadable" };
  }
}

const absent = (check: RuledCheck, where: string): Verdict => ({
  score: 0,
  reason: `no file matches "${check.path ?? ""}" in the ${where}`,
});

/**
 * Says why a directory that cannot be listed settles a check.
 * @param how - The rule of the check, which says whether it is about a pattern or about line counts.
 * @param check - The check, whose pattern the reason quotes.
 * @param dirs - The directories that could not be listed.
 * @returns A sentence that names the directories and what could not be shown.
 */
const closedReason = (
  how: TextRule,
  check: RuledCheck,
  dirs: string[],
): string =>
  `${shown(dirs)} cannot be listed, so files in it cannot be shown ${how === LACKS ? `to lack ${shownPattern(check)}` : "to be within the line bounds"}`;

/**
 * Scores a check over the text of every file its path names.
 * @param how - What the check does with the files.
 * @param check - The check, whose path and pattern are read.
 * @param outcome - What the run left behind.
 * @returns 1 when the files satisfy the quantifier; else 0 with the paths that did not pass, up to ten.
 */
function overText(how: TextRule, check: RuledCheck, outcome: Outcome): Verdict {
  const tree = treeOf(check, outcome);
  const found = find(tree, check.path ?? "", how.cover);
  if (found.capped !== null) return { score: 0, reason: found.capped };
  if (how.closed && found.unreadable.length > 0) {
    return {
      score: 0,
      reason: closedReason(how, check, found.unreadable),
    };
  }
  const files = found.entries.filter((entry) => entry.kind === "file");
  if (files.length === 0) {
    return withUnlisted(how.none(check, tree.name), found);
  }
  const test = how.test(check);
  const results = files.map((file): Result => {
    const read = readText(file.real);
    if ("problem" in read) {
      return { path: file.path, pass: false, note: read.problem };
    }
    return { path: file.path, ...test(read.text) };
  });
  const quantifier = how.quantifier(check);
  const passing = results.filter(({ pass }) => pass);
  if (
    quantifier === "any"
      ? passing.length > 0
      : passing.length === results.length
  ) {
    return PASS;
  }
  const failing = results.filter(({ pass }) => !pass);
  const listed = failing.map(({ path: file, note }) =>
    note === undefined ? file : `${file} (${note})`,
  );
  return withUnlisted(
    {
      score: 0,
      reason: `${how.failed(check, quantifier)}: ${shown(listed)}`,
    },
    found,
  );
}

// The compiled pattern of a check, tested without the position a `g` or `y` flag would carry between files.
const patternTest = (check: RuledCheck): ((text: string) => boolean) => {
  const expression = regex(check.pattern ?? "", check.flags);
  return (text) => {
    expression.lastIndex = 0;
    return expression.test(text);
  };
};
const shownPattern = (check: RuledCheck): string =>
  `/${check.pattern ?? ""}/${check.flags ?? ""}`;

const MATCHES: TextRule = {
  cover: false,
  closed: false,
  none: absent,
  quantifier: (check) => valueOf(check, "quantifier") as "any" | "all",
  test: (check) => {
    const matched = patternTest(check);
    return (text) => ({ pass: matched(text) });
  },
  failed: (check, quantifier) =>
    quantifier === "any"
      ? `no file matches ${shownPattern(check)}`
      : `not every file matches ${shownPattern(check)}`,
};

const LACKS: TextRule = {
  cover: true,
  closed: true,
  none: () => PASS,
  quantifier: (check) => valueOf(check, "quantifier") as "any" | "all",
  test: (check) => {
    const matched = patternTest(check);
    return (text) => ({ pass: !matched(text) });
  },
  failed: (check, quantifier) =>
    `${quantifier === "any" ? "every file" : "files"} that match ${shownPattern(check)} or cannot be read`,
};

const LINES: TextRule = {
  cover: true,
  closed: true,
  none: absent,
  quantifier: () => "all",
  test: (check) => (text) => {
    const lines = countLines(text);
    const { min = 0, max = Infinity } = check;
    return {
      pass: lines >= min && lines <= max,
      note: `${String(lines)} ${lines === 1 ? "line" : "lines"}`,
    };
  },
  failed: () => "files outside the line bounds",
};

const PATTERN_FIELDS = {
  fields: ["path", "pattern"],
  optional: ["flags", "quantifier", "root"],
} satisfies Partial<Spec>;

// The checks of what the files of a run say.
export const TEXT_CHECKS = {
  file_matches: {
    ...PATTERN_FIELDS,
    scores:
      "A file at `path` matches the regular expression. With a glob, one matching file is enough unless `quantifier` is `all`. No match for the path scores 0.",
    note: "A file is read as UTF-8, with replacement characters for bytes that are not, and a file over 5 MB scores 0.",
    rule: (check, outcome) => overText(MATCHES, check, outcome),
  },
  file_lacks: {
    ...PATTERN_FIELDS,
    scores:
      "No file at `path` matches the regular expression. With a glob, every matching file must lack it unless `quantifier` is `any`. A path that matches no file scores 1. A plain path that names a directory, or ends in `/`, means every file under it.",
    note: "A file over 5 MB, or one that cannot be read, and a directory that cannot be listed, cannot be shown to lack the pattern, so each scores 0.",
    rule: (check, outcome) => overText(LACKS, check, outcome),
  },
  file_lines: {
    fields: ["path"],
    optional: ["min", "max", "root"],
    oneOf: ["min", "max"],
    scores:
      "Every file at `path` has from `min` to `max` lines. A path that matches no file scores 0. A plain path that names a directory, or ends in `/`, means every file under it.",
    note: "A file over 5 MB scores 0.",
    validate: checkBounds,
    rule: (check, outcome) => overText(LINES, check, outcome),
  },
} satisfies Record<string, Spec>;
