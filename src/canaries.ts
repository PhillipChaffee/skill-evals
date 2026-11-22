import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Harness } from "./harnesses/shared.js";
import { isObject } from "./scope.js";
import { diffSnapshots, snapshot, snapshotFiles } from "./snapshot.js";
import type { Snapshot } from "./snapshot.js";
import { canonical, sha256 } from "./tree-hash.js";

/** One path that a harness keeps on the operator's machine: where it is, and for a JSON file which keys to hash. */
export type Canary =
  NonNullable<Harness["canaries"]> extends (env: never) => (infer One)[]
    ? One
    : never;

// Files and directories of the operator's home that every run must leave alone, whatever the harness.
const COMMON: Canary[] = [".gitconfig", ".npmrc", ".ssh"].map((file) => ({
  path: file,
}));
// The most files hashed of the project root or of one canary directory, as for a glob.
const CANARY_LIMIT = 5000;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

/** What a run's canaries are. */
export interface CanarySpec {
  /** The operator's real home. */
  home: string;
  /** What to hash under the home. */
  canaries: Canary[];
  /** The project root; null to watch none. */
  root: string | null;
  /** The output directory, which the command writes while runs are in flight, so it is left out. */
  out: string | null;
}

/** What watching the canaries found. */
export interface CanaryReport {
  /** Each path that differs after the run, with how. */
  changed: string[];
  /** Why the watch was not complete, such as a cap that was hit; a check that reads this scores 0. */
  problems: string[];
}

/**
 * Lists what a run of a harness must not touch.
 * @param harness - The adapter, which names its own files.
 * @param env - The operator's environment.
 * @returns The adapter's canaries, then `.gitconfig`, `.npmrc` and `.ssh`.
 */
export const canariesOf = (
  harness: Pick<Harness, "canaries">,
  env: NodeJS.ProcessEnv = process.env,
): Canary[] => [...(harness.canaries?.(env) ?? []), ...COMMON];

/**
 * Names a path for a reason.
 * @param home - The operator's home.
 * @param file - An absolute path.
 * @returns `~/<path>` under the home, else the path.
 */
const labelOf = (home: string, file: string): string => {
  const relative = path.relative(home, file);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? file
    : `~/${relative.split(path.sep).join("/")}`;
};

/**
 * Collects the values at key paths of a parsed JSON value.
 * @param value - The value at the current place.
 * @param where - The rest of the key path, where `*` matches any key (`parts`), and the name of the entry so far (`at`).
 * @param where.parts - What is left of the key path.
 * @param where.at - The entry's name so far.
 * @param found - Receives the hash of each value that the path reaches.
 */
function pick(
  value: unknown,
  where: { parts: string[]; at: string },
  found: Map<string, string>,
): void {
  const { at } = where;
  const [head, ...rest] = where.parts;
  if (head === undefined) {
    found.set(at, sha256(canonical(value)));
    return;
  }
  if (!isObject(value)) return;
  const names =
    head === "*"
      ? Object.keys(value)
      : Object.hasOwn(value, head)
        ? [head]
        : [];
  for (const name of names) {
    pick(
      value[name],
      { parts: rest, at: at.endsWith("#") ? `${at}${name}` : `${at}.${name}` },
      found,
    );
  }
}

/**
 * Hashes the chosen values of a JSON file.
 * @param file - The file's path.
 * @param keys - Key paths, with `*` for any one key.
 * @param label - The file's name in a reason.
 * @returns One entry for each value reached; the file's own hash when it is not JSON; none when it is absent.
 */
function hashKeys(file: string, keys: string[], label: string): Snapshot {
  const found: Snapshot = new Map();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return found;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    for (const key of keys)
      pick(parsed, { parts: key.split("."), at: `${label}#` }, found);
  } catch {
    found.set(label, sha256(text));
  }
  return found;
}

/**
 * Tells a directory from a file.
 * @param file - A path.
 * @returns True for a directory, false for anything else that exists, null for nothing.
 */
function isDirectory(file: string): boolean | null {
  try {
    return fs.lstatSync(file).isDirectory();
  } catch {
    return null;
  }
}

/**
 * Hashes one canary of the home.
 * @param spec - What to watch.
 * @param one - The canary.
 * @param problems - Receives why a directory was not watched whole.
 * @returns The hashes, keyed by a name for a reason.
 */
function takeOne(spec: CanarySpec, one: Canary, problems: string[]): Snapshot {
  const file = path.resolve(spec.home, one.path);
  const label = labelOf(spec.home, file);
  if (one.json) return hashKeys(file, one.json, label);
  const taken: Snapshot = new Map();
  const dir = isDirectory(file);
  if (dir === null) return taken;
  const inside = dir
    ? snapshot(file, () => false, CANARY_LIMIT + 1)
    : snapshotFiles(path.dirname(file), [path.basename(file)]);
  if (inside.size > CANARY_LIMIT) {
    problems.push(`${label} holds more than ${String(CANARY_LIMIT)} files`);
  }
  for (const [name, hash] of inside) {
    taken.set(dir ? `${label}/${name}` : label, hash);
  }
  return taken;
}

/**
 * Lists the files of a project that a person would see: the ones git tracks and the ones it does not ignore.
 * @param root - The project root.
 * @returns Relative posix paths; null when the root is not a git repository or git cannot be run.
 */
function listedByGit(root: string): string[] | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: Infinity,
      },
    );
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Hashes the project root.
 * @param root - The directory of the project, which may be a git repository.
 * @param out - The output directory, which the command writes while runs are in flight.
 * @param problems - Receives why the root was not watched whole.
 * @returns The hash of each file, keyed `project:<path>`.
 */
function takeProject(
  root: string,
  out: string | null,
  problems: string[],
): Snapshot {
  const left =
    out === null ? "" : path.relative(root, out).split(path.sep).join("/");
  const inside = left !== "" && !left.startsWith("..");
  const skipped = (relative: string): boolean =>
    relative.split("/").some((part) => SKIPPED_DIRS.has(part)) ||
    (inside && (relative === left || relative.startsWith(`${left}/`)));
  const listed = listedByGit(root)?.filter((file) => !skipped(file));
  const taken =
    listed === undefined
      ? snapshot(root, skipped, CANARY_LIMIT + 1)
      : snapshotFiles(root, listed.slice(0, CANARY_LIMIT + 1));
  if (taken.size > CANARY_LIMIT) {
    problems.push(
      `the project root holds more than ${String(CANARY_LIMIT)} files`,
    );
  }
  return new Map([...taken].map(([file, hash]) => [`project:${file}`, hash]));
}

/**
 * Hashes the canaries.
 * @param spec - What to watch.
 * @returns The hash of every file, and why the watch was not complete.
 */
function take(spec: CanarySpec): { taken: Snapshot; problems: string[] } {
  const problems: string[] = [];
  const taken: Snapshot = new Map();
  for (const one of spec.canaries) {
    for (const [name, hash] of takeOne(spec, one, problems))
      taken.set(name, hash);
  }
  if (spec.root !== null) {
    for (const [name, hash] of takeProject(spec.root, spec.out, problems))
      taken.set(name, hash);
  }
  return { taken, problems };
}

/**
 * Starts watching the canaries: it hashes them now, never reading a file into the result.
 * @param spec - What to watch.
 * @returns A function that hashes them again and reports what differs, each path with how it differs, and why the watch
 *   was not complete.
 */
export function watchCanaries(spec: CanarySpec): () => CanaryReport {
  const before = take(spec);
  return () => {
    const after = take(spec);
    const changed = diffSnapshots(before.taken, after.taken);
    return {
      changed: [
        ...changed.created.map((file) => `${file} (created)`),
        ...changed.modified.map((file) => `${file} (modified)`),
        ...changed.deleted.map((file) => `${file} (deleted)`),
      ],
      problems: [...new Set([...before.problems, ...after.problems])],
    };
  };
}
