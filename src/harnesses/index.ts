import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../scope.js";
import claudeCode from "./claude-code.js";
import codex from "./codex.js";
import cursor from "./cursor.js";
import opencode from "./opencode.js";
import pi from "./pi.js";
import type { Harness } from "./shared.js";

// Default-preference order: the first installed one runs when --harness is absent.
// Pi leads because it has the smallest install, the fastest start, and reports tokens and cost.
export const HARNESSES: Harness[] = [pi, claudeCode, cursor, opencode, codex];

/** A harness with the executable to spawn for it. */
export interface Located {
  harness: Harness;
  bin: string;
}

type Env = Record<string, string | undefined>;

const overrideVar = (harness: Harness): string =>
  `SKILL_EVALS_BIN_${harness.id.toUpperCase().replaceAll("-", "_")}`;

/**
 * Tells whether a path can be spawned.
 * @param file - A path, which need not exist.
 * @returns True for a regular file that this user may execute.
 */
function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Looks for a harness on this machine.
 * @param harness - The harness to find.
 * @param env - Where `PATH` and the harness's `SKILL_EVALS_BIN_<ID>` override are read from.
 * @returns The executable to spawn, or null when the harness is not installed.
 */
export function findBin(
  harness: Harness,
  env: Env = process.env,
): string | null {
  const bin = env[overrideVar(harness)] || harness.bin;
  const candidates = bin.includes(path.sep)
    ? [path.resolve(bin)]
    : (env["PATH"] ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, bin));
  return candidates.find(isExecutable) ?? null;
}

/**
 * Looks a harness up by its id.
 * @param id - What the user typed.
 * @returns The harness.
 * @throws {UsageError} When no harness has the id.
 */
function byId(id: string): Harness {
  const harness = HARNESSES.find((h) => h.id === id);
  if (!harness) {
    throw new UsageError(
      `unknown harness "${id}"; known: ${HARNESSES.map((h) => h.id).join(", ")}`,
    );
  }
  return harness;
}

/**
 * Reads a `--harness` value.
 * @param spec - A comma-separated list of ids, or "all".
 * @returns The harnesses the list names; every known harness when the list is absent or "all".
 * @throws {UsageError} When the list names an unknown harness.
 */
export function namedHarnesses(spec: string | undefined): Harness[] {
  return !spec || spec === "all"
    ? HARNESSES
    : spec.split(",").map((id) => byId(id.trim()));
}

/**
 * Chooses the harnesses a run uses.
 * @param spec - A `--harness` value. Absent means the first installed harness in preference order.
 * @param env - Where the executables are looked up.
 * @returns The chosen harnesses, each with its executable, and why they were chosen.
 * @throws {UsageError} When a named harness is not installed, or none is installed at all.
 */
export function selectHarnesses(
  spec: string | undefined,
  env: Env = process.env,
): { chosen: Located[]; reason: string } {
  const order = HARNESSES.map((h) => h.id).join(", ");
  const located = namedHarnesses(spec).map((harness) => ({
    harness,
    bin: findBin(harness, env),
  }));
  const installed = located.flatMap(({ harness, bin }) =>
    bin ? [{ harness, bin }] : [],
  );
  if (spec && spec !== "all") {
    const missing = located
      .filter((entry) => !entry.bin)
      .map(
        ({ harness }) =>
          `${harness.id} (no "${harness.bin}" on PATH; set ${overrideVar(harness)})`,
      );
    if (missing.length) {
      throw new UsageError(`harness not installed: ${missing.join("; ")}`);
    }
    return { chosen: installed, reason: "named with --harness" };
  }
  const [first] = installed;
  if (!first) {
    throw new UsageError(`no harness is installed; looked for ${order}`);
  }
  if (spec === "all") {
    return { chosen: installed, reason: `every installed harness of ${order}` };
  }
  return {
    chosen: [first],
    reason: `default, the first installed harness in the order ${order}`,
  };
}
