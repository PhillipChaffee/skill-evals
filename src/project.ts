import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { requireBlindingWords } from "./blinding.js";
import { requireEnvNames } from "./env.js";
import { reportFormats } from "./report/formats.js";
import { globToRegExp } from "./glob.js";
import { SCHEMA_KEY, checkSchemaKey } from "./schema-key.js";
import { listOf } from "./case-roots.js";
import { UsageError, messageOf } from "./scope.js";

/** The project a command works on. Relative paths on a command line resolve against cwd. */
export interface Project {
  root: string;
  isGitRepo: boolean;
  cwd: string;
}

/**
 * Finds the project that holds a working directory.
 * @param cwd - The working directory of the command.
 * @returns The git top level of cwd, or cwd itself when it is not in a git repository.
 */
export function findProject(cwd: string): Project {
  try {
    const root = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return { root: root.trim(), isGitRepo: true, cwd };
  } catch {
    return { root: fs.realpathSync(cwd), isGitRepo: false, cwd };
  }
}

/** The largest seed: the generator takes 32 bits. */
export const MAX_SEED = 4294967295;

/**
 * Tells whether a value is usable as the seed of the bootstrap.
 * @param value - A number from a flag or the config file.
 * @returns True for an integer from 1 to `MAX_SEED`.
 */
export const isSeed = (value: number): boolean =>
  Number.isInteger(value) && value >= 1 && value <= MAX_SEED;

export const CONFIG_FILE = "skill-evals.config.json";
/** The type of a config key that takes one text or a list of texts. */
export const TEXT_OR_LIST = "string | string[]";
// Config key -> the type of its value. Each key is the default of the option with the same name.
export const CONFIG_KEYS: Record<
  string,
  "string" | "number" | "boolean" | "string[]" | typeof TEXT_OR_LIST
> = {
  cases: TEXT_OR_LIST,
  heldoutCases: TEXT_OR_LIST,
  harness: "string",
  reps: "number",
  jobs: "number",
  retries: "number",
  maxCost: "number",
  maxDuration: "number",
  model: "string",
  judgeHarness: "string",
  judgeModel: "string",
  judgeApi: "string",
  judgeUrl: "string",
  judgeKeyVar: "string",
  judgeTimeout: "number",
  judgeFallbacks: "boolean",
  decisionModel: "string",
  decisionUrl: "string",
  decisionTimeout: "number",
  minScore: "number",
  minDelta: "number",
  noise: "string",
  seed: "number",
  maxInvalid: "number",
  report: "string[]",
  maxJudgedWeightShare: "number",
  lenient: "boolean",
  isolated: "boolean",
  sandbox: "boolean",
  sandboxExpose: "string[]",
  historyMode: "string",
  keepWorkspaces: "boolean",
  env: "string[]",
  subjectExclude: "string[]",
  rules: "string",
  instructionFile: "string",
  blindingWords: "string[]",
};

/** The project's optional config file. */
export interface Config {
  /** The directories that hold the cases, one path or a list. Default: `evals/cases`. */
  cases?: string | string[];
  /** The directories whose every case is held out, one path or a list. */
  heldoutCases?: string | string[];
  harness?: string;
  reps?: number;
  /** How many runs may be in flight at once, a positive integer. Default: 1. */
  jobs?: number;
  /** Tries after the first for a run that failed for a reason that is not the agent's, a non-negative integer. Default: 0. */
  retries?: number;
  /** Stop starting runs once the command has spent this many US dollars, a positive number. Default: no limit. */
  maxCost?: number;
  /** Stop starting runs once the command has run this many minutes, a positive number. Default: no limit. */
  maxDuration?: number;
  model?: string;
  judgeHarness?: string;
  judgeModel?: string;
  /** Ask the judge model over this API and start no harness for it. Only "anthropic". Default: a harness session. */
  judgeApi?: string;
  /** The base URL of the judge API. Default: the provider's own. */
  judgeUrl?: string;
  /** The variable that holds the judge API's key. Default: ANTHROPIC_API_KEY. */
  judgeKeyVar?: string;
  /** The seconds one judge request may take, a positive integer. Default: 120. */
  judgeTimeout?: number;
  /** Ask the server to fall back when the judge model refuses. Default: true. */
  judgeFallbacks?: boolean;
  decisionModel?: string;
  decisionUrl?: string;
  decisionTimeout?: number;
  minScore?: number;
  /** The least score difference, B minus A, that the suite must show, from -1 to 1. Default: no bar. */
  minDelta?: number;
  /** A `noise.json` that `calibrate` wrote, which the verdicts of a comparison use. Resolves against the project root. */
  noise?: string;
  /** The seed of the bootstrap, a positive integer up to 4294967295. Default: 1. */
  seed?: number;
  /** The share of the planned runs that may be invalid before the command exits 3, from 0 to 1. Default: 0. */
  maxInvalid?: number;
  /** The report formats to write: "md", "json", "junit", "html". Default: ["md"]. */
  report?: string[];
  /** The share of a case's weight that judge and decision checks may carry before `validate` warns. Default: 0.5. */
  maxJudgedWeightShare?: number;
  lenient?: boolean;
  /** Start every run with nothing loaded but the subject, and invalidate a run that loaded anything else. */
  isolated?: boolean;
  /** Run the harness process in an OS sandbox. Default: false. */
  sandbox?: boolean;
  /** Absolute paths that `--sandbox` binds back read-only into the directories it hides, for a layout it does not know. */
  sandboxExpose?: string[];
  /** How a case's `history.json` reaches the agent: "native" or "preamble". Default: each harness's own, which is "preamble". */
  historyMode?: string;
  /** Archive each run's workspace, seed, remotes and home, less the login files, next to its other files. Default: false. */
  keepWorkspaces?: boolean;
  /** Exact names of variables of this process that the harness gets besides the allowlist. */
  env?: string[];
  /** Globs, relative to the subject, of paths that a run never gets: they are left out of its copy. */
  subjectExclude?: string[];
  /** A directory of the subject whose files are its rules, which an adapter with the `rules` capability installs. */
  rules?: string;
  /** A file of the subject that the harness reads as its instructions; its text counts as rule text. */
  instructionFile?: string;
  /** The words that `validate` and the start of a command look for in what the agent can see. Replaces the default list. Each is a non-empty lowercase word. */
  blindingWords?: string[];
}

/**
 * Checks the range of the numeric keys that have one beyond their type.
 * @param file - The config file, for the message.
 * @param key - A numeric key.
 * @param value - What the file holds.
 * @throws {UsageError} When `minDelta` is not from -1 to 1, or `seed` is not a positive integer up to `MAX_SEED`.
 */
function checkRange(file: string, key: string, value: number): void {
  if (key === "minDelta" && !(value >= -1 && value <= 1)) {
    throw new UsageError(`${file}: "minDelta" must be a number from -1 to 1`);
  }
  if (key === "seed" && !isSeed(value)) {
    throw new UsageError(
      `${file}: "seed" must be a positive integer up to ${String(MAX_SEED)}`,
    );
  }
}

/**
 * Checks a list of globs or of paths.
 * @param file - The config file, for the message.
 * @param key - `subjectExclude`, whose entries are globs, or `sandboxExpose`, whose entries are absolute paths.
 * @param list - The entries.
 * @throws {UsageError} For an empty or invalid glob, or a path that is not absolute.
 */
function checkPaths(file: string, key: string, list: string[]): void {
  for (const one of list) {
    if (key === "subjectExclude") {
      if (one === "")
        throw new UsageError(`${file}: "${key}" has an empty glob`);
      globToRegExp(one);
    } else if (!path.isAbsolute(one)) {
      throw new UsageError(
        `${file}: "${key}" needs absolute paths, not "${one}"`,
      );
    }
  }
}

/**
 * Checks the value of a key that takes a single text, a number or a boolean.
 * @param file - The config file, for the message.
 * @param key - A known key.
 * @param value - What the file holds.
 * @throws {UsageError} When the value has the wrong type or is out of its range.
 */
function checkScalar(file: string, key: string, value: unknown): void {
  if (typeof value !== CONFIG_KEYS[key]) {
    throw new UsageError(
      `${file}: "${key}" must be a ${String(CONFIG_KEYS[key])}`,
    );
  }
  checkRange(file, key, value as number);
  if (
    (key === "maxJudgedWeightShare" || key === "maxInvalid") &&
    !((value as number) >= 0 && (value as number) <= 1)
  ) {
    throw new UsageError(`${file}: "${key}" must be a number from 0 to 1`);
  }
}

/**
 * Checks the entries of a list that the key's meaning gives rules to.
 * @param file - The config file, for the message.
 * @param key - A list key.
 * @param list - The entries, which are all texts.
 * @throws {UsageError} When an entry breaks the key's rule.
 */
function checkEntries(file: string, key: string, list: string[]): void {
  const at = `${file}: "${key}"`;
  if (key === "subjectExclude" || key === "sandboxExpose") {
    checkPaths(file, key, list);
  } else if (key === "report") {
    reportFormats({ report: list }, at);
  } else if (key === "blindingWords") {
    requireBlindingWords(list, at);
  } else if (key !== "cases" && key !== "heldoutCases") {
    requireEnvNames(list, at);
  }
}

/**
 * Checks the value of one config key.
 * @param file - The config file, for the message.
 * @param key - A known key.
 * @param value - What the file holds.
 * @throws {UsageError} When the value has the wrong type, or lists a name that names this tool.
 */
function checkValue(file: string, key: string, value: unknown): void {
  const type = CONFIG_KEYS[key] ?? "string";
  if (type === TEXT_OR_LIST && typeof value === "string") return;
  if (type !== "string[]" && type !== TEXT_OR_LIST) {
    checkScalar(file, key, value);
    return;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new UsageError(
      `${file}: "${key}" must be ${type === "string[]" ? "a list of strings" : "a string or a list of strings"}`,
    );
  }
  checkEntries(file, key, value as string[]);
}

/**
 * Reads `skill-evals.config.json` from the project root.
 * @param root - The project root.
 * @returns The config, with `cases` as an absolute path resolved against the root. Empty when the project has no config file.
 * @throws {UsageError} When the file is not one JSON object, or has an unknown key or a value of the wrong type.
 */
function loadConfig(root: string): Config {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new UsageError(`${file}: ${messageOf(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`${file}: must hold one JSON object`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (key === SCHEMA_KEY) {
      checkSchemaKey(file, { [key]: value as unknown });
      continue;
    }
    if (!Object.hasOwn(CONFIG_KEYS, key)) {
      throw new UsageError(
        `${file}: unknown key "${key}"; known: ${Object.keys(CONFIG_KEYS).join(", ")}`,
      );
    }
    checkValue(file, key, value);
  }
  // Every key and value type was checked above.
  const config = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => key !== SCHEMA_KEY),
  ) as Config;
  return {
    ...config,
    ...(config.cases === undefined
      ? {}
      : { cases: listOf(config.cases).map((dir) => path.resolve(root, dir)) }),
    ...(config.heldoutCases === undefined
      ? {}
      : {
          heldoutCases: listOf(config.heldoutCases).map((dir) =>
            path.resolve(root, dir),
          ),
        }),
    ...(config.noise === undefined
      ? {}
      : { noise: path.resolve(root, config.noise) }),
  };
}

/**
 * Layers the options a command works with.
 * @param project - Where the config file and the default cases directory are.
 * @param options - What the caller set; a property that is undefined counts as not set.
 * @returns The built-in default for `cases`, then the config file, then every option that is set. `cases` and
 *   `heldoutCases` are lists of absolute paths; the second is empty when nothing sets it.
 */
export function withConfig<Options extends object>(
  project: Project,
  options: Options & {
    cases?: string | string[] | undefined;
    heldoutCases?: string | string[] | undefined;
    noise?: string | undefined;
  },
): Omit<Config, "cases" | "heldoutCases"> &
  Omit<Options, "cases" | "heldoutCases"> & {
    cases: string[];
    heldoutCases: string[];
  } {
  const set = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as typeof options;
  const config = loadConfig(project.root);
  const absolute = (dirs: string | string[] | undefined, base: string) =>
    listOf(dirs).map((dir) => path.resolve(base, dir));
  return {
    ...config,
    ...set,
    cases:
      set.cases === undefined
        ? config.cases === undefined
          ? [path.join(project.root, "evals", "cases")]
          : listOf(config.cases)
        : absolute(set.cases, project.cwd),
    heldoutCases:
      set.heldoutCases === undefined
        ? listOf(config.heldoutCases)
        : absolute(set.heldoutCases, project.cwd),
    ...(set.noise === undefined
      ? {}
      : { noise: path.resolve(project.cwd, set.noise) }),
  };
}
