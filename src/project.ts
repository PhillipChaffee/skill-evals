import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { requireEnvNames } from "./env.js";
import { globToRegExp } from "./glob.js";
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

export const CONFIG_FILE = "skill-evals.config.json";
// Config key -> the type of its value. Each key is the default of the option with the same name.
export const CONFIG_KEYS: Record<
  string,
  "string" | "number" | "boolean" | "string[]"
> = {
  cases: "string",
  harness: "string",
  reps: "number",
  model: "string",
  judgeHarness: "string",
  judgeModel: "string",
  decisionModel: "string",
  decisionUrl: "string",
  decisionTimeout: "number",
  minScore: "number",
  lenient: "boolean",
  isolated: "boolean",
  env: "string[]",
  subjectExclude: "string[]",
};

/** The project's optional config file. */
export interface Config {
  cases?: string;
  harness?: string;
  reps?: number;
  model?: string;
  judgeHarness?: string;
  judgeModel?: string;
  decisionModel?: string;
  decisionUrl?: string;
  decisionTimeout?: number;
  minScore?: number;
  lenient?: boolean;
  /** Start every run with nothing loaded but the subject, and invalidate a run that loaded anything else. */
  isolated?: boolean;
  /** Exact names of variables of this process that the harness gets besides the allowlist. */
  env?: string[];
  /** Globs, relative to the subject, of paths that a run never gets: they are left out of its copy. */
  subjectExclude?: string[];
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
  if (type !== "string[]") {
    if (typeof value !== type) {
      throw new UsageError(`${file}: "${key}" must be a ${type}`);
    }
    return;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new UsageError(`${file}: "${key}" must be a list of strings`);
  }
  if (key === "subjectExclude") {
    for (const glob of value as string[]) {
      if (glob === "")
        throw new UsageError(`${file}: "${key}" has an empty glob`);
      globToRegExp(glob);
    }
    return;
  }
  requireEnvNames(value as string[], `${file}: "${key}"`);
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
    if (!Object.hasOwn(CONFIG_KEYS, key)) {
      throw new UsageError(
        `${file}: unknown key "${key}"; known: ${Object.keys(CONFIG_KEYS).join(", ")}`,
      );
    }
    checkValue(file, key, value);
  }
  // Every key and value type was checked above.
  const config = parsed as Config;
  return config.cases === undefined
    ? config
    : { ...config, cases: path.resolve(root, config.cases) };
}

/**
 * Layers the options a command works with.
 * @param project - Where the config file and the default cases directory are.
 * @param options - What the caller set; a property that is undefined counts as not set.
 * @returns The built-in default for `cases`, then the config file, then every option that is set. `cases` is absolute.
 */
export function withConfig<Options extends object>(
  project: Project,
  options: Options & { cases?: string | undefined },
): Config & Options & { cases: string } {
  const set = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as typeof options;
  return {
    cases: path.join(project.root, "evals", "cases"),
    ...loadConfig(project.root),
    ...set,
    ...(set.cases === undefined
      ? {}
      : { cases: path.resolve(project.cwd, set.cases) }),
  };
}
