import fs from "node:fs";
import path from "node:path";

/** One file of a subject's rules that a run installs: a file of the rules directory, or the instruction file. */
export interface RulesFile {
  /** Where the file is, in the run's copy of the subject. */
  path: string;
  /** For a rule, its path inside the rules directory; for the instruction file, its name. Posix separators. */
  relative: string;
  role: "rule" | "instruction";
}

/** Where one file goes: a path under the run's workspace or under its throwaway home. */
export interface RulesTarget {
  root: "workspace" | "home";
  /** Relative to `root`, with `/` as the separator. */
  path: string;
}

/**
 * Copies rule files to the places an adapter chose.
 * @param files - The files to install.
 * @param targets - One place for each file, in the same order.
 * @param dirs - The run's directories.
 * @param dirs.home - The run's home directory, where user-level files go.
 * @param dirs.workspace - The directory the agent works in.
 * @returns The places, as paths relative to their root, in the order of `files`.
 * @throws {Error} When a place is already taken, which an install never overwrites.
 */
export function placeRules(
  files: RulesFile[],
  targets: RulesTarget[],
  dirs: { home: string; workspace: string },
): string[] {
  return files.map((file, index) => {
    const target = targets[index] as RulesTarget;
    const to = path.join(dirs[target.root], target.path);
    if (fs.existsSync(to)) {
      throw new Error(`${target.path} already exists in the ${target.root}`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(file.path, to);
    return target.path;
  });
}
