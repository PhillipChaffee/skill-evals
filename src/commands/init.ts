import fs from "node:fs";
import path from "node:path";
import { EXIT } from "../exit-codes.js";
import { hasReservedChar, isCaseDir, isSkippedName } from "../discover.js";
import { TEMPLATES } from "../init-templates.js";
import type { Project } from "../project.js";
import { withConfig } from "../project.js";
import { UsageError } from "../scope.js";
import type { Options } from "../usage.js";

const JSON_INDENT = 2;

/** The kinds of case that `init` starts from. */
const KINDS = Object.keys(TEMPLATES);

/**
 * Says what is wrong with a case id, by the rules that discovery applies to a case's directory.
 * @param id - The id as typed: the case's path below the cases directory, with `/`.
 * @returns The problem, or null when the id is fine. An id is not fine when it is empty, has an empty part, `.` or
 *   `..`, holds `@` or `,` in a part, or has a part that starts with `_`, which discovery skips.
 */
function idProblem(id: string): string | null {
  const parts = id.split("/");
  const bad = parts.find(
    (part) =>
      part === "" || part === "." || part === ".." || /[\\\s]/.test(part),
  );
  if (bad !== undefined) {
    return `"${id}" has an empty part, "." or "..", a space or a backslash; an id is a path of folder names joined by "/"`;
  }
  if (parts.some(hasReservedChar)) {
    return `"${id}": a directory name may not hold "@" or ","`;
  }
  if (parts.some(isSkippedName)) {
    return `"${id}": a directory name that starts with "_" is never a case`;
  }
  return null;
}

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
      `init needs --kind ${KINDS.join("|")}${kind === undefined ? "" : `, not "${kind}"`}`,
    );
  }
  const problem = idProblem(id);
  if (problem !== null) throw new UsageError(problem);
  const { cases } = withConfig(project, options);
  const above = caseAbove(cases, id);
  if (above !== null) {
    throw new UsageError(
      `${id} would sit inside the case ${above}, and nothing under a case is searched`,
    );
  }
  const dir = path.join(cases, ...id.split("/"));
  if (fs.existsSync(dir)) {
    throw new UsageError(`${dir} already exists; init never overwrites a case`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "prompt.md"), template.prompt);
  fs.writeFileSync(
    path.join(dir, "case.json"),
    `${JSON.stringify(template.case, null, JSON_INDENT)}\n`,
  );
  console.log(
    [
      `wrote ${path.join(dir, "prompt.md")}`,
      `wrote ${path.join(dir, "case.json")}`,
      ...(template.next === undefined ? [] : [template.next]),
    ].join("\n"),
  );
  return EXIT.ok;
}
