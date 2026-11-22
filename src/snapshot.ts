import { createHash } from "node:crypto";
import fs from "node:fs";
import { walkTree } from "./walk.js";

/** Relative posix path to the SHA-256 of what is there. A link is hashed by its target text. */
export type Snapshot = Map<string, string>;

/** What differs between two snapshots, each list sorted. */
export interface ChangedFiles {
  created: string[];
  modified: string[];
  deleted: string[];
}

const UNREADABLE = "unreadable";
// What a directory that cannot be listed is hashed as, so that it can be told from a file that cannot be read.
const UNLISTABLE = "unlistable";
const CHUNK = 1_048_576;
// One buffer for every file: hashing is synchronous, so two files never use it at once.
const BUFFER = Buffer.alloc(CHUNK);
const sha256 = (data: string): string =>
  createHash("sha256").update(data).digest("hex");

/**
 * Hashes a file in chunks of one mebibyte, so that a file of any size is read without being held whole, and a small
 * file costs one read.
 * @param file - Its path.
 * @returns The SHA-256 of its bytes.
 */
function hashFile(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    for (;;) {
      const read = fs.readSync(fd, BUFFER, 0, CHUNK, null);
      if (read === 0) break;
      hash.update(BUFFER.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Hashes one entry that is not a directory.
 * @param file - Its path.
 * @param entry - What the directory listing said it is.
 * @returns The hash; "unreadable" for a file that cannot be read and for anything that is no file or link.
 */
function hashOf(file: string, entry: fs.Dirent): string {
  try {
    if (entry.isSymbolicLink()) return sha256(fs.readlinkSync(file));
    return entry.isFile() ? hashFile(file) : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

/**
 * Hashes every file and link under a directory. It never follows a link.
 * @param dir - The directory.
 * @param skip - Tells a relative posix path that is left out; a directory that it skips is left out whole.
 * @returns The snapshot. A directory that cannot be listed is one entry of its own, hashed as "unlistable".
 */
export function snapshot(
  dir: string,
  skip: (relative: string) => boolean = () => false,
): Snapshot {
  const taken: Snapshot = new Map();
  walkTree(dir, {
    skip,
    unreadable: (relative) => {
      if (relative) taken.set(relative, UNLISTABLE);
    },
    visit: ({ relative, file, dirent }) => {
      if (!dirent.isDirectory()) taken.set(relative, hashOf(file, dirent));
      return undefined;
    },
  });
  return taken;
}

/**
 * Compares two snapshots of one directory.
 * @param before - The earlier snapshot.
 * @param after - The later one.
 * @returns The paths only the later one has, the paths in both whose hash differs, and the paths only the earlier one
 *   has.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): ChangedFiles {
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
 * Puts two lists of changes together.
 * @param first - One change.
 * @param second - Another.
 * @returns The created, modified and deleted paths of both, each list sorted.
 */
export const mergeChanges = (
  first: ChangedFiles,
  second: ChangedFiles,
): ChangedFiles => ({
  created: [...first.created, ...second.created].sort(),
  modified: [...first.modified, ...second.modified].sort(),
  deleted: [...first.deleted, ...second.deleted].sort(),
});

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

/**
 * Lists the directories that a snapshot could not look into.
 * @param taken - A snapshot.
 * @returns Their relative paths, sorted.
 */
export const unlistedIn = (taken: Snapshot): string[] =>
  [...taken]
    .filter(([, hash]) => hash === UNLISTABLE)
    .map(([file]) => file)
    .sort();
