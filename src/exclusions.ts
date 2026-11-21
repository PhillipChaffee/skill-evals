import fs from "node:fs";
import path from "node:path";
import { literalGlob } from "./glob.js";
import { CONFIG_FILE } from "./project.js";
import { UsageError } from "./scope.js";

/** What an export leaves out, besides `.git` and `node_modules`. */
export interface Exclusions {
  /** Globs relative to the root of the subject, from the config key `subjectExclude`. */
  globs: string[];
  /** The cases directory. It may not be, or contain, a subject. Null when no command has one. */
  cases: string | null;
  /** The output directory. It may not be a subject. Null when it is a temp directory, which is never inside one. */
  out: string | null;
}

/** No exclusion beyond the built-in ones. */
export const NO_EXCLUSIONS: Exclusions = { globs: [], cases: null, out: null };

/**
 * Gathers what the export of every subject of a command leaves out.
 * @param options - The command's options after the config file was applied.
 * @param options.cases - The absolute path of the cases directory.
 * @param options.subjectExclude - The config key of the same name.
 * @param options.outDir - The output directory as the user gave it; absent for a temp directory.
 * @param cwd - What a relative output directory resolves against.
 * @returns The globs of the config, the cases directory, and the output directory.
 */
export function exclusionsOf(
  options: {
    cases: string;
    subjectExclude?: string[] | undefined;
    outDir?: string | undefined;
  },
  cwd: string,
): Exclusions {
  return {
    globs: options.subjectExclude ?? [],
    cases: options.cases,
    out: options.outDir ? path.resolve(cwd, options.outDir) : null,
  };
}

/**
 * Resolves the links in a path, even when its last parts do not exist yet.
 * @param target - A path.
 * @returns The real path of its deepest existing ancestor, with the rest appended.
 */
function realish(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    const parent = path.dirname(path.resolve(target));
    return parent === target
      ? target
      : path.join(realish(parent), path.basename(target));
  }
}

/** Where a directory is, seen from a subject's root. */
type Place = "same" | "inside" | "contains" | "apart";

/**
 * Places a directory against a root.
 * @param root - The root of a subject.
 * @param dir - Another directory.
 * @returns How they relate, and for a directory inside the root, its glob.
 */
function placeOf(root: string, dir: string): { place: Place; glob: string } {
  const down = path.relative(realish(root), realish(dir));
  const leaves = (relative: string): boolean =>
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);
  if (down === "") return { place: "same", glob: "" };
  if (!leaves(down)) {
    const glob = literalGlob(down.split(path.sep).join("/"));
    return { place: "inside", glob };
  }
  const up = path.relative(realish(dir), realish(root));
  return { place: leaves(up) ? "apart" : "contains", glob: "" };
}

/**
 * Works out what the export of one subject leaves out.
 * @param named - The flag and what the user passed, and the subject's root, for a message.
 * @param named.flag - How the user named the subject, such as `--a main`.
 * @param named.root - The directory the subject is exported from.
 * @param named.project - The project root, whose config file is never part of a subject.
 * @param left - What the command leaves out.
 * @returns Globs relative to the subject's root.
 * @throws {UsageError} When the cases directory is or contains the subject, or the output directory is the subject.
 */
export function globsFor(
  named: { flag: string; root: string; project: string },
  left: Exclusions,
): string[] {
  const { flag, root } = named;
  const inside = (dir: string): string[] => {
    const { place, glob } = placeOf(root, dir);
    return place === "inside" ? [glob] : [];
  };
  if (left.cases !== null) {
    const { place } = placeOf(root, left.cases);
    if (place === "same" || place === "contains") {
      throw new UsageError(
        `${flag}: the cases directory ${left.cases} is, or contains, the subject directory ${root}, so the agent would read every case; keep the cases outside the subject`,
      );
    }
  }
  if (left.out !== null && placeOf(root, left.out).place === "same") {
    throw new UsageError(
      `${flag}: the output directory ${left.out} is the subject directory ${root}; choose another --out`,
    );
  }
  return [
    ...left.globs,
    ...inside(path.join(named.project, CONFIG_FILE)),
    ...(left.cases === null ? [] : inside(left.cases)),
    ...(left.out === null ? [] : inside(left.out)),
  ];
}
