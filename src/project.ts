import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

const CONFIG_FILE = "skill-evals.config.json";
// Config key -> the type of its value. Each key is the default of the option with the same name.
const CONFIG_KEYS: Record<string, "string" | "number"> = {
  cases: "string",
  harness: "string",
  reps: "number",
  model: "string",
  judgeHarness: "string",
  judgeModel: "string",
  decisionModel: "string",
  decisionUrl: "string",
  minScore: "number",
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
  minScore?: number;
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
    const type = Object.hasOwn(CONFIG_KEYS, key) ? CONFIG_KEYS[key] : undefined;
    if (!type) {
      throw new UsageError(
        `${file}: unknown key "${key}"; known: ${Object.keys(CONFIG_KEYS).join(", ")}`,
      );
    }
    if (typeof value !== type) {
      throw new UsageError(`${file}: "${key}" must be a ${type}`);
    }
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
