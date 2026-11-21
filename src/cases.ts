import fs from "node:fs";
import path from "node:path";
import type { FieldDef, Mode } from "./checks/fields.js";
import { WEIGHT, extensionsOf, readField } from "./checks/fields.js";
import type { Check } from "./checks/index.js";
import { readCheck } from "./checks/index.js";
import { UsageError, messageOf } from "./scope.js";

/** One prompt and what a good run of it does. */
export interface Case {
  id: string;
  prompt: string;
  checks: Check[];
  weight: number;
  minScore?: number | undefined;
  maxTurns?: number | undefined;
  timeoutSeconds: number;
  /** A directory whose content the agent starts with, or null for an empty workspace. */
  workspaceDir: string | null;
  /** The keys of the case file that start with `x-`, which belong to the case's author. */
  extensions: Record<string, unknown>;
}

// The top-level keys of a case file. Any other key is a load error, unless it starts with `x-`.
export const CASE_KEYS: Record<string, FieldDef> = {
  checks: { type: "object", meaning: "A non-empty list of checks." },
  weight: {
    ...WEIGHT,
    meaning: "How much the case counts in its suite. Default: 1.",
  },
  minScore: {
    type: "unit",
    meaning: "The lowest score the case may get and still pass.",
  },
  maxTurns: {
    type: "int",
    meaning: "The most turns the agent may take. Only Claude Code applies it.",
  },
  timeoutSeconds: {
    type: "int",
    meaning: "The seconds a run may take. Default: 600.",
  },
};

const DEFAULT_TIMEOUT_SECONDS = 600;

/**
 * Loads one case from its directory.
 * @param dir - A directory with `prompt.md`, `case.json`, and an optional `workspace/`.
 * @param mode - Whether a key that the case file does not take is an error or is dropped with a warning.
 * @returns The case, named after the directory.
 * @throws {UsageError} When a file is missing or does not hold a valid case.
 */
function loadCase(dir: string, mode: Mode): Case {
  const id = path.basename(dir);
  const file = path.join(dir, "case.json");
  let prompt;
  let raw: Record<string, unknown> | null | undefined;
  try {
    prompt = fs.readFileSync(path.join(dir, "prompt.md"), "utf8").trim();
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as typeof raw;
  } catch (error) {
    throw new UsageError(`case ${id}: ${messageOf(error)}`);
  }
  if (!prompt) throw new UsageError(`case ${id}: prompt.md is empty`);
  const checks = raw?.["checks"];
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new UsageError(`${file}: "checks" must be a non-empty array`);
  }
  const at = { where: file, owner: "a case", siblings: raw ?? {} };
  const extensions = extensionsOf(Object.keys(CASE_KEYS), at, mode);
  // A null weight counts as none, as it did before keys were typed.
  const read = (key: string): unknown =>
    raw?.[key] === undefined || (key === "weight" && raw[key] === null)
      ? undefined
      : readField(CASE_KEYS, key, at);
  const workspaceDir = path.join(dir, "workspace");
  return {
    id,
    prompt,
    checks: checks.map((check: unknown, index) =>
      readCheck(check, `${file} checks[${String(index)}]`, mode),
    ),
    weight: (read("weight") as number | undefined) ?? 1,
    minScore: read("minScore") as number | undefined,
    maxTurns: read("maxTurns") as number | undefined,
    timeoutSeconds:
      (read("timeoutSeconds") as number | undefined) ?? DEFAULT_TIMEOUT_SECONDS,
    workspaceDir: fs.existsSync(workspaceDir) ? workspaceDir : null,
    extensions,
  };
}

/**
 * Loads the cases of a suite.
 * @param casesDir - A directory with one subdirectory for each case.
 * @param glob - Selects cases by id; only `*` is special.
 * @param options - `lenient` drops a key that a case file does not take instead of failing, and `onWarning` hears of
 *   each one.
 * @param options.lenient - Drop unknown keys instead of failing. Default: false.
 * @param options.onWarning - Called with a line of text for each key that `lenient` drops.
 * @returns Every matching case, sorted by id.
 * @throws {UsageError} When the directory cannot be read, a case is invalid, or no case matches.
 */
export function loadCases(
  casesDir: string,
  glob = "*",
  options: { lenient?: boolean; onWarning?: (text: string) => void } = {},
): Case[] {
  const mode: Mode = {
    lenient: options.lenient ?? false,
    warn:
      options.onWarning ??
      ((text) => {
        console.error(`skill-evals: warning: ${text}`);
      }),
  };
  const literal = (part: string): string =>
    part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`^${glob.split("*").map(literal).join(".*")}$`);
  let entries;
  try {
    entries = fs.readdirSync(casesDir, { withFileTypes: true });
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    throw new UsageError(
      `cannot read the cases directory ${casesDir} (${String(code)}); create it or pass --cases`,
    );
  }
  const cases = entries
    .filter((entry) => entry.isDirectory() && matcher.test(entry.name))
    .map((entry) => loadCase(path.join(casesDir, entry.name), mode))
    .sort((x, y) => x.id.localeCompare(y.id));
  if (cases.length === 0) {
    throw new UsageError(`no case in ${casesDir} matches "${glob}"`);
  }
  return cases;
}
