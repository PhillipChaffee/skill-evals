import fs from "node:fs";
import path from "node:path";
import { EXIT } from "../exit-codes.js";
import { idProblem } from "../case-id.js";
import { isCaseDir } from "../discover.js";
import type { Template } from "../init-templates.js";
import { TEMPLATES } from "../init-templates.js";
import type { Project } from "../project.js";
import { withConfig } from "../project.js";
import { UsageError, messageOf } from "../scope.js";
import type { Options } from "../usage.js";

const JSON_INDENT = 2;

/** The kinds of case that `init` starts from. */
const KINDS = Object.keys(TEMPLATES);

/**
 * Finds a case that the new id would sit inside, because discovery never looks below a case.
 * @param casesDir - The cases directory.
 * @param id - The valid id of the new case.
 * @returns The id of the case above it, or null.
 */
function caseAbove(casesDir: string, id: string): string | null {
  const parts = id.split("/").slice(0, -1);
  const above = parts
    .map((_, index) => parts.slice(0, index + 1))
    .find((names) => isCaseDir(path.join(casesDir, ...names)));
  return above?.join("/") ?? null;
}

/**
 * Finds the topmost directory on a path that does not exist yet.
 * @param dir - A directory that may not exist.
 * @returns The first missing directory from the top, which `mkdir -p` would create first; null when `dir` exists.
 */
function topMissing(dir: string): string | null {
  let missing: string | null = null;
  for (
    let at = dir;
    !fs.existsSync(at) && at !== path.dirname(at);
    at = path.dirname(at)
  ) {
    missing = at;
  }
  return missing;
}

/**
 * Removes what `init` made, without ever failing: the caller is already reporting an error.
 * @param made - The topmost directory that `init` created.
 */
function undo(made: string): void {
  try {
    fs.rmSync(made, { recursive: true, force: true });
  } catch {
    // Nothing more can be done; the usage error that follows says what failed first.
  }
}

/**
 * Creates the case directory and its two files, or leaves nothing of it.
 * @param dir - The case's directory.
 * @param template - What to write.
 * @throws {UsageError} When the directory exists (another `init` may have just made it), a folder on its path is a
 *   file, or any file system call fails. Every directory that this call made, the parents included, is removed when
 *   a later step fails, except after finding the case directory already there, which is another `init`'s.
 */
function writeCase(dir: string, template: Template): void {
  const made = topMissing(path.dirname(dir)) ?? dir;
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
  } catch (error) {
    undo(made);
    throw new UsageError(`cannot create ${dir}: ${messageOf(error)}`);
  }
  try {
    // Not recursive: an existing directory is an error here, and only one of two `init` calls can make it.
    fs.mkdirSync(dir);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "EEXIST") {
      throw new UsageError(
        `${dir} already exists; init never overwrites a case`,
      );
    }
    undo(made);
    throw new UsageError(`cannot create ${dir}: ${messageOf(error)}`);
  }
  try {
    fs.writeFileSync(path.join(dir, "prompt.md"), template.prompt, {
      flag: "wx",
    });
    fs.writeFileSync(
      path.join(dir, "case.json"),
      `${JSON.stringify(template.case, null, JSON_INDENT)}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    undo(made);
    throw new UsageError(`cannot write ${dir}: ${messageOf(error)}`);
  }
}

/**
 * The `init` command: writes `prompt.md` and `case.json` for a new case from a template.
 * @param options - The command line's options: `kind` and `cases`.
 * @param project - Where the config file and the default cases directory are.
 * @param args - The new case's id.
 * @returns The exit code, always 0; a fault throws.
 * @throws {UsageError} For a missing or unknown `--kind`, an id that no case could have, an id inside another case,
 *   or a directory that already exists: nothing is overwritten.
 */
export function init(
  options: Options,
  project: Project,
  args: string[],
): number {
  const id = String(args[0]);
  const { kind } = options;
  const template =
    kind !== undefined && Object.hasOwn(TEMPLATES, kind)
      ? TEMPLATES[kind]
      : undefined;
  if (!template) {
    throw new UsageError(
      `init needs --kind ${KINDS.join("|")}${kind === undefined ? "" : `, not ${JSON.stringify(kind)}`}`,
    );
  }
  const problem = idProblem(id);
  if (problem !== null) throw new UsageError(problem);
  const { cases } = withConfig(project, options);
  const above = caseAbove(cases, id);
  if (above !== null) {
    throw new UsageError(
      `${JSON.stringify(id)} would sit inside the case ${above}, and nothing under a case is searched`,
    );
  }
  const dir = path.join(cases, ...id.split("/"));
  writeCase(dir, template);
  console.log(
    [
      `wrote ${path.join(dir, "prompt.md")}`,
      `wrote ${path.join(dir, "case.json")}`,
      ...(template.next === undefined ? [] : [template.next]),
    ].join("\n"),
  );
  return EXIT.ok;
}
