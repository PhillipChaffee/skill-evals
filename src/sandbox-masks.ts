import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findOnPath } from "./capabilities.js";
import { CA_VARIABLES } from "./env.js";
import { UsageError } from "./scope.js";

// How many path parts of an npm package a scoped (`@scope/name`) and a plain name take after `node_modules`.
const SCOPED_PARTS = 3;
const PLAIN_PARTS = 2;
const RESOLV_CONF = "/etc/resolv.conf";

/**
 * Resolves a path to a real directory.
 * @param target - A path that may not exist.
 * @returns Its real path when it is a directory; null otherwise.
 */
function realDir(target: string | undefined): string | null {
  if (!target) return null;
  try {
    const real = fs.realpathSync(target);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Tells whether a path is a directory or lies inside one.
 * @param child - A path.
 * @param parent - A directory.
 * @returns True for the directory itself and for anything below it.
 */
const within = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
};

/**
 * Drops the paths that lie inside another of the list, and repeats.
 * @param paths - Real paths.
 * @returns The outermost ones, in the order given.
 */
const outermost = (paths: string[]): string[] => {
  const unique = [...new Set(paths)];
  return unique.filter(
    (one) => !unique.some((other) => other !== one && within(one, other)),
  );
};

/**
 * Finds what a harness's executable needs to start: where it really is, and the package around it when it is an npm
 * package.
 * @param bin - The executable as the run names it.
 * @param pathVariable - The value of `PATH` that a bare name is looked up in.
 * @returns The real path of the executable's directory, widened to its package root.
 */
function installOf(bin: string, pathVariable: string | undefined): string[] {
  const found = path.isAbsolute(bin)
    ? bin
    : findOnPath(bin, { PATH: pathVariable });
  if (found === null) return [];
  try {
    const real = fs.realpathSync(found);
    const parts = real.split(path.sep);
    const at = parts.lastIndexOf("node_modules");
    const scoped = parts[at + 1]?.startsWith("@") === true;
    return [
      at < 0
        ? path.dirname(real)
        : parts
            .slice(0, at + (scoped ? SCOPED_PARTS : PLAIN_PARTS))
            .join(path.sep),
    ];
  } catch {
    return [];
  }
}

/** What a run hides from the harness, and what it gives back. */
export interface Masking {
  masked: string[];
  exposed: string[];
}

/** What decides the masks of one run. */
interface Where {
  casesDirs?: string[] | undefined;
  outDir: string;
  projectRoot?: string | undefined;
  bin: string;
  subjectDir?: string | undefined;
  /** The config's `env`: variables whose values are files that the harness reads. */
  pass?: string[] | undefined;
  /** The config's `sandboxExpose`. */
  expose?: string[] | undefined;
  /** Where the resolver's configuration is. Default: `/etc/resolv.conf`. */
  resolvConf?: string | undefined;
}

const warned = new Set<string>();

/**
 * Resolves a path.
 * @param file - A path.
 * @returns Its real path; null when it does not exist.
 */
function realOrNull(file: string | undefined): string | null {
  try {
    return file ? fs.realpathSync(file) : null;
  } catch {
    return null;
  }
}

/**
 * Finds the root of an install that a file belongs to: the directory above `bin/`, or the directory itself.
 * @param real - The real path of an executable.
 * @returns The install root, so that a Node under Volta or asdf finds its libraries.
 */
const rootOf = (real: string): string =>
  path.basename(path.dirname(real)) === "bin"
    ? path.dirname(path.dirname(real))
    : path.dirname(real);

/**
 * Finds the Node that the harness and the mock servers run on: the one this process runs, and the one on `PATH`.
 * @param pathVariable - The value of `PATH` to search.
 * @returns The real path of each executable and of its install root.
 */
function nodeOf(pathVariable: string | undefined): string[] {
  return [process.execPath, findOnPath("node", { PATH: pathVariable })].flatMap(
    (file) => {
      const real = realOrNull(file ?? undefined);
      return real === null ? [] : [real, rootOf(real)];
    },
  );
}

/**
 * Lists the files that the variables the harness is passed name: the certificate variables, and the config's `env`.
 * @param pass - The config's `env`.
 * @returns The real path of each one that exists.
 */
function namedByVariables(pass: string[] | undefined): string[] {
  return [...CA_VARIABLES, ...(pass ?? [])].flatMap((name) => {
    const real = realOrNull(process.env[name]);
    return real === null ? [] : [real];
  });
}

/**
 * Lists the directories of `PATH` that may be bound back.
 * @param pathVariable - The value of `PATH` to search.
 * @param roots - Every directory that is hidden, which is never bound back whole.
 * @returns The real path of each directory that exists and is not a root; one that is, or is relative, is warned about once.
 */
function directoriesOnPath(
  pathVariable: string | undefined,
  roots: Set<string>,
): string[] {
  return (pathVariable ?? "").split(path.delimiter).flatMap((entry) => {
    const real = path.isAbsolute(entry) ? realOrNull(entry) : null;
    if (real !== null && !roots.has(real)) return [real];
    if (real === null && path.isAbsolute(entry)) return [];
    if (!warned.has(entry)) {
      warned.add(entry);
      console.error(
        `skill-evals: warning: --sandbox does not bind "${entry === "" ? "(empty)" : entry}" back from PATH: it is relative, or it is your home, the cases directory or another directory that the sandbox hides`,
      );
    }
    return [];
  });
}

/**
 * Checks the config's `sandboxExpose`.
 * @param paths - The entries.
 * @param casesDirs - The cases directories.
 * @throws {UsageError} For an entry that is not absolute, does not exist, or is your real home or the cases directory.
 */
export function requireExposable(paths: string[], casesDirs: string[]): void {
  const never = [os.homedir(), ...casesDirs].map(realOrNull);
  for (const one of paths) {
    const real = path.isAbsolute(one) ? realOrNull(one) : null;
    if (real === null) {
      throw new UsageError(
        `sandboxExpose: "${one}" must be an absolute path that exists`,
      );
    }
    if (never.includes(real)) {
      throw new UsageError(
        `sandboxExpose: "${one}" is your home or the cases directory, which the sandbox exists to hide`,
      );
    }
  }
}

/**
 * Works out what the sandbox hides behind an empty directory: your real home, the temp directories, `/run` (which holds
 * the sockets of Docker, the user bus and ssh-agent), the cases directory, the output directory, and the project root;
 * and what is bound back so that the harness can start, each inside a hidden directory: its install, Node and the
 * install root of each, the directories of `PATH`, the files that the certificate and the passed variables name, the
 * directory that holds the resolver's configuration, the run's copy of the subject, and the config's `sandboxExpose`.
 * @param where - The run's paths.
 * @returns The directories to hide, outermost only, and the paths to bind back.
 */
export function maskingOf(where: Where): Masking {
  const roots = [
    os.homedir(),
    "/tmp",
    os.tmpdir(),
    "/run",
    "/var/run",
    ...(where.casesDirs ?? []),
    where.outDir,
    where.projectRoot,
  ]
    .map(realDir)
    .filter(
      (dir): dir is string => dir !== null && dir !== path.parse(dir).root,
    );
  const masked = outermost(roots);
  const pathVariable = process.env["PATH"];
  const resolver = realOrNull(where.resolvConf ?? RESOLV_CONF);
  const wanted = [
    ...installOf(where.bin, pathVariable),
    ...nodeOf(pathVariable),
    ...directoriesOnPath(pathVariable, new Set(roots)),
    ...namedByVariables(where.pass),
    ...(resolver === null ? [] : [path.dirname(resolver)]),
    ...(where.expose ?? []),
    where.subjectDir,
  ]
    .map((one) => realOrNull(one))
    .filter((one): one is string => one !== null)
    .filter((one) => masked.some((dir) => within(one, dir)));
  return { masked, exposed: outermost(wanted) };
}
