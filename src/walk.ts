import fs from "node:fs";
import path from "node:path";

/** One entry met while walking a tree. */
interface TreeEntry {
  /** The path relative to the root, with `/` as the separator. */
  relative: string;
  file: string;
  /** What the directory listing says it is; a link is not followed. */
  dirent: fs.Dirent;
}

/** How to walk a tree. */
interface Walk {
  /** Tells a relative path that is left out. A directory that it skips is not entered. */
  skip?: (relative: string) => boolean;
  /** Called for every entry that is not skipped, before the entry's contents. Returning false keeps a directory closed. */
  visit: (entry: TreeEntry) => boolean | undefined;
  /** Called with the relative path of a directory that cannot be listed ("" for the root). Default: the error is thrown. */
  unreadable?: (relative: string) => void;
}

/**
 * Walks every entry under a directory, depth first, never following a link.
 * @param root - The directory.
 * @param options - What to skip, what to do with each entry, and what to do with a directory that cannot be listed.
 */
export function walkTree(root: string, options: Walk): void {
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (!options.unreadable) throw error;
      options.unreadable(prefix.slice(0, -1));
      return;
    }
    for (const dirent of entries) {
      const relative = `${prefix}${dirent.name}`;
      if (options.skip?.(relative)) continue;
      const file = path.join(dir, dirent.name);
      const enter = options.visit({ relative, file, dirent });
      if (enter !== false && dirent.isDirectory()) walk(file, `${relative}/`);
    }
  };
  walk(root, "");
}
