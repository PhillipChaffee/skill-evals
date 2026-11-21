import path from "node:path";
import { findOnPath, isExecutable } from "../capabilities.js";
import { UsageError } from "../scope.js";
import claudeCode from "./claude-code.js";
import codex from "./codex.js";
import cursor from "./cursor.js";
import opencode from "./opencode.js";
import pi from "./pi.js";
import type { Harness } from "./shared.js";

/**
 * The harness adapters in default-preference order: the first installed one runs when `--harness` is absent.
 * Pi leads because it has the smallest install, the fastest start, and reports tokens and cost.
 */
export const HARNESSES: Harness[] = [pi, claudeCode, cursor, opencode, codex];

/** A harness with the executable to spawn for it. */
export interface Located {
  harness: Harness;
  bin: string;
}

type Env = Record<string, string | undefined>;

/**
 * Names the environment variable that replaces a harness's executable.
 * @param harness - The harness to start.
 * @returns `SKILL_EVALS_BIN_` and the id in upper case, with underscores for dashes.
 */
export const overrideVar = (harness: Harness): string =>
  `SKILL_EVALS_BIN_${harness.id.toUpperCase().replaceAll("-", "_")}`;

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
  if (!bin.includes(path.sep)) return findOnPath(bin, env);
  return isExecutable(path.resolve(bin)) ? path.resolve(bin) : null;
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
 * Keeps the harnesses that are installed.
 * @param harnesses - The harnesses to look for. Default: every known one.
 * @param env - Where the executables are looked up.
 * @returns Each installed harness with its executable, in the order given.
 */
export function installedOf(
  harnesses: Harness[] = HARNESSES,
  env: Env = process.env,
): Located[] {
  return harnesses.flatMap((harness) => {
    const bin = findBin(harness, env);
    return bin ? [{ harness, bin }] : [];
  });
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
  const installed = installedOf(
    located.map(({ harness }) => harness),
    env,
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

/**
 * Refuses `--isolated` for a harness that cannot start isolated and prove from its report what it loaded.
 * @param chosen - The harnesses that will run.
 * @param role - What they do, put before their names in the message; empty for the harnesses under test.
 * @throws {UsageError} Naming each harness that lacks the `isolated` or the `loadedReport` capability.
 */
export function requireIsolation(chosen: Located[], role = ""): void {
  const lacking = chosen
    .map(({ harness }) => harness)
    .filter(
      (harness) =>
        !(
          harness.capabilities.has("isolated") &&
          harness.capabilities.has("loadedReport")
        ),
    )
    .map((harness) => harness.id);
  if (lacking.length > 0) {
    throw new UsageError(
      `--isolated cannot run with ${role ? `${role} ` : ""}${lacking.join(", ")}: the harness must start with nothing loaded but the subject and prove from its own report what it loaded`,
    );
  }
}

/**
 * Refuses `--isolated` unless the harnesses under test and the judge harness can both isolate and prove it.
 * @param chosen - The harnesses that will run.
 * @param judge - The harness that scores judged checks; absent when it is the harness under test.
 * @throws {UsageError} Naming the harnesses that cannot.
 */
export function requireIsolatedRun(
  chosen: Located[],
  judge: Located | undefined,
): void {
  requireIsolation(chosen);
  requireIsolation(judge ? [judge] : [], "the judge harness");
}
