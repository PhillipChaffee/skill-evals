import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findOnPath } from "./capabilities.js";

// How many path parts of an npm package a scoped (`@scope/name`) and a plain name take after `node_modules`.
const SCOPED_PARTS = 3;
const PLAIN_PARTS = 2;
const DNS = { conf: "/etc/resolv.conf", dir: "/run/systemd/resolve" };

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

/**
 * Works out what the sandbox hides behind an empty directory: your real home, the temp directories, `/run` (which holds
 * the sockets of Docker, the user bus and ssh-agent), the cases directory, the output directory, and the project root;
 * and what is bound back so that the harness can start: its install, the directories of `PATH`, the subject's export
 * and the resolver's directory.
 * @param where - The run's paths.
 * @param where.casesDir - The cases directory; absent when the plan has none.
 * @param where.outDir - The output directory.
 * @param where.projectRoot - The project root; absent when the plan has none.
 * @param where.bin - The harness's executable.
 * @param where.subjectDir - The run's copy of the subject; absent for "none".
 * @param where.dns - Where the resolver's configuration and its directory are; for tests.
 * @returns The directories to hide, outermost only, and the paths to bind back, each inside a hidden directory.
 */
export function maskingOf(where: {
  casesDir?: string | undefined;
  outDir: string;
  projectRoot?: string | undefined;
  bin: string;
  subjectDir?: string | undefined;
  /** Where the resolver's configuration is, and the directory it points into when the system resolves names itself. Default: `/etc/resolv.conf` and `/run/systemd/resolve`. */
  dns?: { conf: string; dir: string } | undefined;
}): Masking {
  const masked = outermost(
    [
      os.homedir(),
      "/tmp",
      os.tmpdir(),
      "/run",
      "/var/run",
      where.casesDir,
      where.outDir,
      where.projectRoot,
    ]
      .map(realDir)
      .filter(
        (dir): dir is string => dir !== null && dir !== path.parse(dir).root,
      ),
  );
  const pathVariable = process.env["PATH"];
  const dns = where.dns ?? DNS;
  const resolver = realOf(dns.conf).startsWith(dns.dir) ? [dns.dir] : [];
  const wanted = [
    ...installOf(where.bin, pathVariable),
    ...(pathVariable ?? "").split(path.delimiter),
    where.subjectDir,
    ...resolver,
  ]
    .map((one) => {
      try {
        return one ? fs.realpathSync(one) : null;
      } catch {
        return null;
      }
    })
    .filter((one): one is string => one !== null)
    .filter((one) => masked.some((dir) => within(one, dir)));
  return { masked, exposed: outermost(wanted) };
}

/**
 * Resolves a path.
 * @param file - A path.
 * @returns Its real path; the path itself when it cannot be resolved.
 */
function realOf(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}
