import fs from "node:fs";
import path from "node:path";
import type { Need } from "./capabilities.js";
import type { FieldDef, Mode } from "./checks/fields.js";
import { WEIGHT, extensionsOf, readField } from "./checks/fields.js";
import type { Check } from "./checks/index.js";
import { readCheck } from "./checks/index.js";
import { globToRegExp } from "./glob.js";
import { HARNESSES } from "./harnesses/index.js";
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
  /** What a harness must be able to do for the case to apply, besides what its checks imply. */
  requires: Need[];
  /** The harnesses the case is for, when it is for some only. A last resort: `note` says why. */
  harnesses?: string[] | undefined;
  /** Why the case is limited to `harnesses`; the report shows it as the reason the case is not applicable elsewhere. */
  note?: string | undefined;
  /** Labels that `--tag`, `--tag-all` and `--not-tag` select by. */
  tags: string[];
  /** What the case shows, in a sentence. */
  description?: string | undefined;
  /** The names of the skills the case is about; the coverage table counts them. */
  targets: string[];
  /** The kind of case, such as `trigger`. */
  kind?: string | undefined;
  /** What a good run does, in a sentence for readers. */
  expected?: string | undefined;
  /** True for a case that must keep passing. The report lists it apart, and it is scored like any case. */
  guard: boolean;
  /** Runs for each subject, in place of `--reps`. */
  reps?: number | undefined;
  /** The model of the agent in this case's runs, in place of `--model`. */
  model?: string | undefined;
  /** The model that scores this case's judged checks, in place of `--judge-model`. */
  judgeModel?: string | undefined;
  /** Variables the agent's process gets, set outright. */
  env: Record<string, string>;
  /** The least score difference between the subjects that the case must show. */
  minDelta?: number | undefined;
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
  requires: {
    type: "needs",
    meaning:
      'A list of capabilities the case needs, such as `"mcp"`, or `"bin:<name>"` for an executable on the host\'s `PATH`. A harness that lacks one reports the case as not applicable.',
  },
  harnesses: {
    type: "texts",
    meaning:
      "The harness ids the case is for. Any other harness reports it as not applicable. Needs `note`. A last resort: prefer `requires`.",
  },
  note: {
    type: "text",
    meaning: "Why the case is limited to `harnesses`. The report shows it.",
  },
  tags: {
    type: "tags",
    meaning:
      "Labels for selecting cases with `--tag`, `--tag-all` and `--not-tag`. Each is lowercase letters, digits and hyphens.",
  },
  description: { type: "text", meaning: "What the case shows, in a sentence." },
  targets: {
    type: "texts",
    meaning:
      "The names of the skills the case is about. The report counts the cases of each in its coverage table.",
  },
  kind: {
    type: "text",
    meaning: "The kind of case, such as `trigger` or `negative`.",
  },
  expected: {
    type: "text",
    meaning:
      "What a good run does, in a sentence. It is for readers; no check reads it.",
  },
  guard: {
    type: "bool",
    meaning:
      "True for a case that must keep passing. The report lists it in its own table. Its score counts in the suite score like any other. Default: false.",
  },
  reps: {
    type: "int",
    meaning: "Runs for each subject in this case, in place of `--reps`.",
  },
  model: {
    type: "text",
    meaning: "The model of the agent in this case, in place of `--model`.",
  },
  judgeModel: {
    type: "text",
    meaning:
      "The model that scores the judged checks of this case, in place of `--judge-model`.",
  },
  env: {
    type: "envvars",
    meaning:
      "Variables the agent's process gets, with the values given here. A name starts with `CASE_`, or is `TZ`, `LANG` or `LC_ALL`.",
  },
  minDelta: {
    type: "unit",
    meaning:
      "The least score difference between the subjects that the case must show. A number from 0 to 1.",
  },
};

const DEFAULT_TIMEOUT_SECONDS = 600;

/** One case directory that discovery found. */
interface Found {
  /** The path of the directory below the cases directory, with `/`. */
  id: string;
  dir: string;
}

/** Reads one key of a case file with its type's parser; undefined when the file leaves the key out. */
type Read = (key: string) => unknown;

/**
 * Reads the harnesses that a case is limited to.
 * @param read - Reads a key of the case file.
 * @param file - The case file, for the messages.
 * @returns The harness ids and the note, both absent for a case that is for every harness.
 * @throws {UsageError} When a harness id is unknown, or `harnesses` has no `note`.
 */
function limitsOf(read: Read, file: string) {
  const harnesses = read("harnesses") as string[] | undefined;
  const note = read("note") as string | undefined;
  if (harnesses) {
    const known = HARNESSES.map((harness) => harness.id);
    const unknown = harnesses.find((id) => !known.includes(id));
    if (unknown !== undefined) {
      throw new UsageError(
        `${file}: unknown harness "${unknown}"; known: ${known.join(", ")}`,
      );
    }
    if (note === undefined) {
      throw new UsageError(
        `${file}: "harnesses" needs a "note" that says why the case is limited`,
      );
    }
  }
  return { harnesses, note };
}

/**
 * Reads the keys that label a case and override the command's settings for it.
 * @param read - Reads a key of the case file.
 * @returns The labels and overrides, with their defaults for the keys the file leaves out.
 */
const settingsOf = (read: Read) => ({
  tags: (read("tags") as string[] | undefined) ?? [],
  description: read("description") as string | undefined,
  targets: (read("targets") as string[] | undefined) ?? [],
  kind: read("kind") as string | undefined,
  expected: read("expected") as string | undefined,
  guard: (read("guard") as boolean | undefined) ?? false,
  reps: read("reps") as number | undefined,
  model: read("model") as string | undefined,
  judgeModel: read("judgeModel") as string | undefined,
  env: (read("env") as Record<string, string> | undefined) ?? {},
  minDelta: read("minDelta") as number | undefined,
});

/**
 * Loads one case from its directory.
 * @param found - The case's id and its directory, which holds `prompt.md`, `case.json`, and an optional `workspace/`.
 * @param mode - Whether a key that the case file does not take is an error or is dropped with a warning.
 * @returns The case, read and checked against the tables of keys and checks.
 * @throws {UsageError} When a file is missing or does not hold a valid case.
 */
function loadCase(found: Found, mode: Mode): Case {
  const { id, dir } = found;
  const file = path.join(dir, "case.json");
  let prompt;
  let raw: Record<string, unknown> | null | undefined;
  if (!fs.existsSync(path.join(dir, "prompt.md"))) {
    throw new UsageError(`case ${id}: no prompt source; add a prompt.md`);
  }
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
  const read: Read = (key) =>
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
    requires: (read("requires") as Need[] | undefined) ?? [],
    ...limitsOf(read, file),
    timeoutSeconds:
      (read("timeoutSeconds") as number | undefined) ?? DEFAULT_TIMEOUT_SECONDS,
    ...settingsOf(read),
    workspaceDir: fs.existsSync(workspaceDir) ? workspaceDir : null,
    extensions,
  };
}

const isCaseDir = (dir: string): boolean =>
  ["prompt.md", "case.json"].some((name) =>
    fs.existsSync(path.join(dir, name)),
  );

/**
 * Finds the case directories under a directory, at any depth. A directory is a case when it holds `prompt.md` or
 * `case.json`. Nothing under a case is searched, and a directory whose name starts with `_` is skipped with all it holds.
 * @param dir - The directory to search.
 * @param prefix - The names of the directories above it, below the cases directory.
 * @returns The cases, unsorted.
 * @throws {UsageError} When a directory cannot be read, or the name of a case's directory holds `@` or `,`.
 */
function discover(dir: string, prefix: string[] = []): Found[] {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    throw new UsageError(
      prefix.length === 0
        ? `cannot read the cases directory ${dir} (${String(code)}); create it or pass --cases`
        : `cannot read ${dir} (${String(code)})`,
    );
  }
  return entries.flatMap((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith("_")) return [];
    const where = path.join(dir, entry.name);
    const names = [...prefix, entry.name];
    if (!isCaseDir(where)) return discover(where, names);
    const id = names.join("/");
    if (names.some((name) => /[@,]/.test(name))) {
      throw new UsageError(
        `case ${id}: a directory name may not hold "@" or ","`,
      );
    }
    return [{ id, dir: where }];
  });
}

/** What loading cases takes besides the directory. */
export interface LoadOptions {
  /** Drop a key that a case file does not take instead of failing. Default: false. */
  lenient?: boolean;
  /** Called with a line of text for each key that `lenient` drops. */
  onWarning?: (text: string) => void;
}

/**
 * Loads the cases whose ids a test accepts. A case that the test rejects is never read, so a fault in it is no error.
 * @param casesDir - The directory to search at any depth.
 * @param keep - Decides from a case's id whether to load it.
 * @param options - How to treat unknown keys.
 * @returns The cases, sorted by id.
 * @throws {UsageError} When the directory cannot be read, or a case is invalid.
 */
export function loadWhere(
  casesDir: string,
  keep: (id: string) => boolean,
  options: LoadOptions,
): Case[] {
  const mode: Mode = {
    lenient: options.lenient ?? false,
    warn:
      options.onWarning ??
      ((text) => {
        console.error(`skill-evals: warning: ${text}`);
      }),
  };
  return discover(casesDir)
    .filter(({ id }) => keep(id))
    .map((found) => loadCase(found, mode))
    .sort((x, y) => x.id.localeCompare(y.id));
}

/**
 * Loads the cases of a suite.
 * @param casesDir - A directory that holds the cases at any depth. A case is a directory with a `prompt.md` or a
 *   `case.json`, and its id is its path below `casesDir`, with `/`.
 * @param glob - Selects cases by id: `*` stays within one directory, `**` crosses directories, `?` is one character
 *   and `{a,b}` is either. Default: every case.
 * @param options - `lenient` drops a key that a case file does not take instead of failing, and `onWarning` hears of
 *   each one.
 * @param options.lenient - Drop unknown keys instead of failing. Default: false.
 * @param options.onWarning - Called with a line of text for each key that `lenient` drops.
 * @returns Every matching case, sorted by id.
 * @throws {UsageError} When the directory cannot be read, a case is invalid, or no case matches.
 */
export function loadCases(
  casesDir: string,
  glob = "**",
  options: LoadOptions = {},
): Case[] {
  const matcher = globToRegExp(glob);
  const cases = loadWhere(casesDir, (id) => matcher.test(id), options);
  if (cases.length === 0) {
    throw new UsageError(`no case in ${casesDir} matches "${glob}"`);
  }
  return cases;
}
