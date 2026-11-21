import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Relative posix path to the SHA-256 of what is there. A link is hashed by its target text. */
export type Snapshot = Map<string, string>;

/** What differs between two snapshots, each list sorted. */
export interface ChangedFiles {
  created: string[];
  modified: string[];
  deleted: string[];
}

const UNREADABLE = "unreadable";
const sha256 = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/**
 * Hashes one entry that is not a directory.
 * @param file - Its path.
 * @param entry - What the directory listing said it is.
 * @returns The hash; "unreadable" for a file that cannot be read and for anything that is no file or link.
 */
function hashOf(file: string, entry: fs.Dirent): string {
  try {
    if (entry.isSymbolicLink()) return sha256(fs.readlinkSync(file));
    return entry.isFile() ? sha256(fs.readFileSync(file)) : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

/**
 * Hashes every file and link under a directory. It never follows a link.
 * @param dir - The directory.
 * @param skip - Tells a relative posix path that is left out; a directory that it skips is left out whole.
 * @returns The snapshot. A directory that cannot be listed is one entry of its own, hashed as unreadable.
 */
export function snapshot(
  dir: string,
  skip: (relative: string) => boolean = () => false,
): Snapshot {
  const taken: Snapshot = new Map();
  const walk = (current: string, prefix: string): void => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      if (prefix) taken.set(prefix.slice(0, -1), UNREADABLE);
      return;
    }
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      if (skip(relative)) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file, `${relative}/`);
      else taken.set(relative, hashOf(file, entry));
    }
  };
  walk(dir, "");
  return taken;
}

/**
 * Compares two snapshots of one directory.
 * @param before - The earlier snapshot.
 * @param after - The later one.
 * @returns The paths only the later one has, the paths in both whose hash differs, and the paths only the earlier one
 *   has.
 */
export function diffSnapshots(
  before: Snapshot,
  after: Snapshot,
): ChangedFiles {
  const created: string[] = [];
  const modified: string[] = [];
  for (const [file, hash] of after) {
    const was = before.get(file);
    if (was === undefined) created.push(file);
    else if (was !== hash) modified.push(file);
  }
  const deleted = [...before.keys()].filter((file) => !after.has(file));
  return {
    created: created.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
  };
}

/**
 * Lists every path of a change in one list.
 * @param changes - What `diffSnapshots` returned.
 * @returns The created paths, then the modified, then the deleted.
 */
export const allChanged = (changes: ChangedFiles): string[] => [
  ...changes.created,
  ...changes.modified,
  ...changes.deleted,
];
