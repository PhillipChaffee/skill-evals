import fs from "node:fs";
import path from "node:path";
import { HARNESSES } from "./harnesses/index.js";
import { requireLinksInside } from "./isolate.js";
import { UsageError, messageOf } from "./scope.js";
import { walkTree } from "./walk.js";

/**
 * Finds a case's `workspace/` folder, and makes sure that no link in it can reach outside it.
 * @param dir - Where the folder would be.
 * @param file - The case file, for an error message.
 * @returns The folder, or null when there is none.
 * @throws {UsageError} Naming the first link whose target is absolute or leads outside the folder: a copy keeps links
 *   as they are, so the agent could write into the case through it.
 */
export function workspaceOf(dir: string, file: string): string | null {
  if (!fs.existsSync(dir)) return null;
  requireOwnLinks(dir, file, "workspace");
  return dir;
}

/**
 * Finds a case's `grader/` folder.
 * @param dir - The case's directory.
 * @param file - The case file, for an error message.
 * @returns The folder, or null when there is none.
 * @throws {UsageError} When `workspace/` holds a `grader/` folder (the agent would start with the held-out files), or
 *   `grader` is not a directory.
 */
export function graderOf(dir: string, file: string): string | null {
  if (fs.existsSync(path.join(dir, "workspace", "grader"))) {
    throw new UsageError(
      `${file}: workspace/grader would give the agent the held-out files; move it beside prompt.md`,
    );
  }
  const grader = path.join(dir, "grader");
  if (!fs.existsSync(grader)) return null;
  if (!fs.statSync(grader).isDirectory()) {
    throw new UsageError(`${file}: grader must be a directory`);
  }
  return grader;
}

/**
 * Makes sure that no link of a directory that a run copies leads out of it.
 * @param dir - The directory.
 * @param file - The case file, for an error message.
 * @param label - The directory as the case names it, which starts the path in the message.
 * @throws {UsageError} Naming the first link whose target is absolute or leads outside the directory.
 */
function requireOwnLinks(dir: string, file: string, label: string): void {
  try {
    requireLinksInside(dir, `the ${path.basename(label)}`);
  } catch (error) {
    throw new UsageError(`${file}: ${label}/${messageOf(error)}`);
  }
}

/**
 * Finds a case's `fixture/` folder: the files that setup steps use, which the agent never sees.
 * @param dir - The case's directory.
 * @param file - The case file, for an error message.
 * @returns The folder, or null when there is none.
 * @throws {UsageError} When `fixture` is not a directory, or a link in it leaves it.
 */
export function fixtureOf(dir: string, file: string): string | null {
  const fixture = path.join(dir, "fixture");
  if (!fs.existsSync(fixture)) return null;
  if (!fs.statSync(fixture).isDirectory()) {
    throw new UsageError(`${file}: fixture must be a directory`);
  }
  requireOwnLinks(fixture, file, "fixture");
  return fixture;
}

const holdsCase = (dir: string): boolean =>
  ["case.json", "prompt.md"].some((name) =>
    fs.existsSync(path.join(dir, name)),
  );

/**
 * Tells whether copying a directory into a run would hand the agent a case's own files: the directory is a case
 * folder, holds one, or is a case's `grader/` or `fixture/` folder or inside one.
 * @param real - The real path of the directory.
 * @returns True when it would.
 */
function exposesCase(real: string): boolean {
  const inside = real
    .split(path.sep)
    .map(
      (_, index, parts) => parts.slice(0, index + 1).join(path.sep) || path.sep,
    )
    .some(
      (each) =>
        ["grader", "fixture"].includes(path.basename(each)) &&
        holdsCase(path.dirname(each)),
    );
  let holds = holdsCase(real);
  walkTree(real, {
    visit: ({ file, dirent }) => {
      holds ||= dirent.isDirectory() && holdsCase(file);
      return undefined;
    },
  });
  return inside || holds;
}

/**
 * Finds the directory that a key of a case file names, and checks it.
 * @param key - The key, for the messages.
 * @param named - The path as written, which is relative to the case's directory.
 * @param where - The case file, and the directory that the path must stay inside.
 * @param where.file - The case file, for an error message.
 * @param where.inside - The directory the path must resolve inside, without being it.
 * @param where.from - What the path is relative to.
 * @param where.outside - The words of the error for a path that leaves `inside`.
 * @returns The absolute path of an existing directory whose links stay inside it.
 * @throws {UsageError} When the path leaves `inside`, does not exist, is no directory, or holds a link that leaves it.
 */
function directoryNamed(
  key: string,
  named: string,
  where: { file: string; inside: string; from: string; outside: string },
): string {
  const resolved = path.resolve(where.from, named);
  const within = (root: string, target: string): boolean => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const fail = (problem: string): UsageError =>
    new UsageError(`${where.file}: ${key}: ${named} ${problem}`);
  if (!within(where.inside, resolved)) throw fail(where.outside);
  if (!fs.existsSync(resolved)) throw fail("does not exist");
  if (!within(fs.realpathSync(where.inside), fs.realpathSync(resolved))) {
    throw fail(where.outside);
  }
  if (!fs.statSync(resolved).isDirectory()) throw fail("is not a directory");
  if (exposesCase(fs.realpathSync(resolved))) {
    throw fail(
      "would copy a case folder, or a grader/ or fixture/ folder, into the run",
    );
  }
  requireOwnLinks(resolved, where.file, named);
  return resolved;
}

/**
 * Finds the shared fixture directories that a case layers into its workspace.
 * @param where - The case's directory, its case file for an error message, and the cases directory, which every
 *   fixture must stay inside.
 * @param where.dir - The case's directory.
 * @param where.file - The case file.
 * @param where.root - The cases directory.
 * @param names - The `fixtures` of the case file, relative to the case's directory; absent when the key is.
 * @returns The directories, in order.
 * @throws {UsageError} When one leaves the cases directory, does not exist, is no directory, or holds a link that
 *   leaves it.
 */
export function fixturesOf(
  where: { dir: string; file: string; root: string },
  names: string[] | undefined,
): string[] {
  const { dir, file, root } = where;
  return (names ?? []).map((named) =>
    directoryNamed("fixtures", named, {
      file,
      from: dir,
      inside: root,
      outside: "is outside the cases directory",
    }),
  );
}

/**
 * Finds the directory that is copied into the run's throwaway home.
 * @param dir - The case's directory.
 * @param file - The case file, for an error message.
 * @param name - The `home` of the case file, relative to the case's directory; absent when the key is.
 * @returns The directory, or null when the case has no `home`.
 * @throws {UsageError} When it leaves the case's directory, does not exist, is no directory, holds a link that leaves
 *   it, or holds a file at the path of a harness's login file, which the run puts there itself.
 */
export function homeOf(
  dir: string,
  file: string,
  name: string | undefined,
): string | null {
  if (name === undefined) return null;
  const home = directoryNamed("home", name, {
    file,
    from: dir,
    inside: dir,
    outside: "must stay inside the case",
  });
  const logins = new Map(
    HARNESSES.flatMap((harness) =>
      harness.authFiles.map((login) => [login, harness.id] as const),
    ),
  );
  walkTree(home, {
    visit: ({ relative }) => {
      const owner = logins.get(relative);
      if (owner !== undefined) {
        throw new UsageError(
          `${file}: home/${relative} is a login file of ${owner}; the run copies the real one there, so a case may not hold one`,
        );
      }
      return undefined;
    },
  });
  return home;
}
