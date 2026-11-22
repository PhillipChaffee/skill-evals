import path from "node:path";
import type { Harness } from "./harnesses/shared.js";
import { diffSnapshots, snapshot } from "./snapshot.js";
import type { Snapshot } from "./snapshot.js";

// Files and directories of the operator's home that every run must leave alone, whatever the harness.
const COMMON = [".gitconfig", ".npmrc", ".ssh"];
// The most files hashed of the project root, as for a glob.
const CANARY_LIMIT = 5000;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

/** What a run's canaries are. */
export interface CanarySpec {
  /** The operator's real home. */
  home: string;
  /** Paths relative to the home. */
  names: string[];
  /** The project root; null to watch none. */
  root: string | null;
  /** The output directory, which the command writes while runs are in flight, so it is left out. */
  out: string | null;
}

/**
 * Names the paths of the operator's home that a run of a harness must not touch.
 * @param harness - The adapter, which names its own state under the home.
 * @returns The adapter's paths, then `.gitconfig`, `.npmrc` and `.ssh`.
 */
export const canaryNames = (harness: Pick<Harness, "canaries">): string[] => [
  ...(harness.canaries?.() ?? []),
  ...COMMON,
];

/**
 * Tells whether a path of the home is a canary, inside one, or on the way to one.
 * @param relative - A posix path relative to the home.
 * @param names - The canaries.
 * @returns True when the walk must look at the path.
 */
const wanted = (relative: string, names: string[]): boolean =>
  names.some(
    (name) =>
      relative === name ||
      relative.startsWith(`${name}/`) ||
      name.startsWith(`${relative}/`),
  );

/**
 * Hashes the canaries.
 * @param spec - What to watch.
 * @returns The hash of every file of the canaries, keyed by `~/<path>` and `project:<path>`.
 */
function take(spec: CanarySpec): Snapshot {
  const taken: Snapshot = new Map();
  const home = snapshot(spec.home, (relative) => !wanted(relative, spec.names));
  for (const [file, hash] of home) taken.set(`~/${file}`, hash);
  const { root, out } = spec;
  if (root === null) return taken;
  const left =
    out === null ? "" : path.relative(root, out).split(path.sep).join("/");
  const inside = left !== "" && !left.startsWith("..");
  const project = snapshot(
    root,
    (relative) =>
      SKIPPED_DIRS.has(relative.slice(relative.lastIndexOf("/") + 1)) ||
      (inside && (relative === left || relative.startsWith(`${left}/`))),
    CANARY_LIMIT,
  );
  for (const [file, hash] of project) taken.set(`project:${file}`, hash);
  return taken;
}

/**
 * Starts watching the canaries: it hashes them now, never reading a file into the result.
 * @param spec - What to watch.
 * @returns A function that hashes them again and lists what differs, each path with how it differs.
 */
export function watchCanaries(spec: CanarySpec): () => string[] {
  const before = take(spec);
  return () => {
    const changed = diffSnapshots(before, take(spec));
    return [
      ...changed.created.map((file) => `${file} (created)`),
      ...changed.modified.map((file) => `${file} (modified)`),
      ...changed.deleted.map((file) => `${file} (deleted)`),
    ];
  };
}
