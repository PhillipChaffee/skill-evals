import fs from "node:fs";
import path from "node:path";
import type { RulesFile } from "./harnesses/rules.js";
import { UsageError } from "./scope.js";
import { walkTree } from "./walk.js";

/** The config options that name a subject's rules; both are paths inside the subject. */
export interface RulesOptions {
  /** A directory of the subject whose files are its rules. */
  rules?: string | undefined;
  /** A file of the subject that the harness reads as its instructions. */
  instructionFile?: string | undefined;
}

/**
 * Tells whether a file of the rules directory is a rule.
 * @param relative - The file's path inside the rules directory.
 * @returns True for a Markdown file; the harnesses read rules from those.
 */
const isRule = (relative: string): boolean => relative.endsWith(".md");

/** What a subject names as its rules, as posix paths relative to the subject's root. */
export interface SubjectRules {
  dir: string | null;
  instructionFile: string | null;
}

/**
 * Reads a path of the subject's rules.
 * @param root - The export of the subject.
 * @param named - What the config says.
 * @param named.option - The config key, for the message.
 * @param named.value - The path as written.
 * @param named.flag - How the user named the subject, for the message.
 * @param want - What the path must be.
 * @returns The path as a posix path, without a leading `./`.
 * @throws {UsageError} When the path is absolute, climbs out of the subject, is missing, is a link, or is not of the
 *   kind that the option takes.
 */
function insideSubject(
  root: string,
  named: { option: string; value: string; flag: string },
  want: "directory" | "file",
): string {
  const { option, value, flag } = named;
  const parts = value
    .split(/[\\/]/)
    .filter((part) => part !== "" && part !== ".");
  if (path.isAbsolute(value) || parts.includes("..") || parts.length === 0) {
    throw new UsageError(
      `${flag}: "${option}" ${value} must be a path inside the subject`,
    );
  }
  const relative = parts.join("/");
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(path.join(root, relative));
  } catch {
    throw new UsageError(`${flag}: "${option}" ${value} is not in the subject`);
  }
  if (entry.isSymbolicLink()) {
    throw new UsageError(
      `${flag}: "${option}" ${value} is a link; rules are never read through a link`,
    );
  }
  const right = want === "directory" ? entry.isDirectory() : entry.isFile();
  if (!right) {
    throw new UsageError(`${flag}: "${option}" ${value} is not a ${want}`);
  }
  return relative;
}

/**
 * Looks through the rules directory.
 * @param base - The rules directory in the export.
 * @param named - Names the directory and the subject, for the messages.
 * @param named.dir - The rules directory as the config names it.
 * @param named.flag - How the user named the subject.
 * @throws {UsageError} For a link in the directory.
 */
function refuseLinksAndWarn(
  base: string,
  named: { dir: string; flag: string },
): void {
  const ignored: string[] = [];
  walkTree(base, {
    visit: ({ relative, dirent }) => {
      if (dirent.isSymbolicLink()) {
        throw new UsageError(
          `${named.flag}: "rules" has a link, ${named.dir}/${relative}; rules are never read through a link`,
        );
      }
      if (dirent.isFile() && !isRule(relative)) ignored.push(relative);
      return undefined;
    },
  });
  if (ignored.length > 0) {
    console.error(
      `skill-evals: warning: ${named.flag}: only .md files of "rules" are installed; not installed: ${ignored.join(", ")}`,
    );
  }
}

/**
 * Checks the rules that a command names against a subject's export.
 * @param options - `rules` and `instructionFile` of the config.
 * @param root - The export of the subject.
 * @param flag - How the user named the subject, for the message.
 * @returns The rules; null when the config names none.
 * @throws {UsageError} For a path that `insideSubject` refuses, or a rules directory with a link in it.
 */
export function resolveRules(
  options: RulesOptions,
  root: string,
  flag: string,
): SubjectRules | null {
  const { rules, instructionFile } = options;
  if (rules === undefined && instructionFile === undefined) return null;
  const dir =
    rules === undefined
      ? null
      : insideSubject(
          root,
          { option: "rules", value: rules, flag },
          "directory",
        );
  const file =
    instructionFile === undefined
      ? null
      : insideSubject(
          root,
          { option: "instructionFile", value: instructionFile, flag },
          "file",
        );
  if (dir !== null && file !== null && file.startsWith(`${dir}/`)) {
    throw new UsageError(
      `${flag}: "instructionFile" ${file} is inside the rules directory ${dir}, so it would be installed twice`,
    );
  }
  if (dir !== null) refuseLinksAndWarn(path.join(root, dir), { dir, flag });
  return { dir, instructionFile: file };
}

/**
 * Lists the files of a subject's rules in a run's copy of the subject.
 * @param rules - What the subject names.
 * @param copy - The run's copy of the subject.
 * @returns The files of the rules directory, sorted, then the instruction file.
 */
export function rulesFilesOf(rules: SubjectRules, copy: string): RulesFile[] {
  const listed: RulesFile[] = [];
  if (rules.dir !== null) {
    const base = path.join(copy, rules.dir);
    walkTree(base, {
      visit: ({ relative, file, dirent }) => {
        if (dirent.isFile() && isRule(relative)) {
          listed.push({ path: file, relative, role: "rule" });
        }
        return undefined;
      },
    });
  }
  listed.sort((x, y) => x.relative.localeCompare(y.relative));
  return rules.instructionFile === null
    ? listed
    : [
        ...listed,
        {
          path: path.join(copy, rules.instructionFile),
          relative: path.posix.basename(rules.instructionFile),
          role: "instruction",
        },
      ];
}
