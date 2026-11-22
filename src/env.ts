import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./scope.js";

// What a harness needs to run at all, to reach the network through a proxy, and to trust the same certificates as the
// user's shell. Nothing else of this process's environment is inherited.
/** The variables that name a certificate file or directory, which a sandbox must leave readable. */
export const CA_VARIABLES = [
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
];
const ALLOWED = new Set([
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TERM",
  "TZ",
  "LANG",
  "LANGUAGE",
  ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"].flatMap((name) => [
    name,
    name.toLowerCase(),
  ]),
  ...CA_VARIABLES,
]);
const LOCALE = /^LC_/;
// This tool's own variables, and the ones npm and the shell set that name the command that is running.
const TOOL_NAMES = "SKILL_EVALS_|npm_|_$";
const NAMES_THIS_TOOL = new RegExp(`^(${TOOL_NAMES})`);
/** `ENV_NAME_RULE` as a regular expression, for the JSON Schema of the config file. */
export const ENV_NAME_PATTERN = `^(?!(?:${TOOL_NAMES}))[^=]+$`;

/** The rule for a name in the `env` option, in words. The reference page quotes it. */
export const ENV_NAME_RULE =
  "An exact variable name: not empty, without `=`, not `_`, and not starting with `SKILL_EVALS_` or `npm_`.";

/**
 * Judges a name of the `env` option.
 * @param name - What the user listed.
 * @returns Why the harness may not get a variable of that name, or null when it may.
 */
export function envNameFault(name: string): string | null {
  if (name === "") return "is empty";
  if (name.includes("=")) return "has an `=`, so it is not a variable name";
  if (NAMES_THIS_TOOL.test(name)) {
    return "names this tool or the command that runs it";
  }
  return null;
}

/**
 * Checks every name of the `env` option. Both the config file and `evaluate` go through it.
 * @param names - What the user listed.
 * @param where - Names the option in the message, such as the config file and key.
 * @throws {UsageError} At the first name that `envNameFault` refuses.
 */
export function requireEnvNames(names: string[], where: string): void {
  for (const name of names) {
    const fault = envNameFault(name);
    if (fault) throw new UsageError(`${where} cannot name "${name}": ${fault}`);
  }
}

/** What this tool is called, in any spelling that a path or a variable may use. */
export const OWN_NAME = /skill.?evals?/i;
const warnedPaths = new Set<string>();

/**
 * Takes the entries that name this tool out of a `PATH` value. `npm run` and `npx` put every ancestor's
 * `node_modules/.bin` on `PATH`, so a checkout whose path names this tool would otherwise show it to the agent.
 * @param value - The `PATH` value.
 * @param needs - Executables the run needs: names to look for in an entry, or absolute paths.
 * @returns The `PATH` value without those entries. One warning on standard error lists them, once for each list.
 * @throws {UsageError} When an entry that names this tool holds a needed executable: it cannot be dropped.
 */
function withoutOwnName(value: string, needs: string[]): string {
  const entries = value.split(path.delimiter);
  const named = entries.filter((entry) => OWN_NAME.test(entry));
  for (const entry of named) {
    const held = needs.find((need) =>
      path.isAbsolute(need)
        ? path.dirname(need) === entry
        : fs.existsSync(path.join(entry, need)),
    );
    if (held !== undefined) {
      throw new UsageError(
        `the PATH entry "${entry}" names this tool and holds ${held}, which the run needs: put ${held} in a directory whose path does not name skill-evals, for example by linking it into ~/bin, and start the command with that directory on PATH`,
      );
    }
  }
  const list = named.join(path.delimiter);
  if (named.length > 0 && !warnedPaths.has(list)) {
    warnedPaths.add(list);
    console.error(
      `skill-evals: warning: left out of the agent's PATH, because they name this tool: ${named.join(", ")}`,
    );
  }
  return entries.filter((entry) => !named.includes(entry)).join(path.delimiter);
}

/** What decides the environment of a harness process. */
export interface ChildEnvInput {
  /** The throwaway home. */
  home: string;
  /** The environment to take the allowed variables from: this process's. */
  base: NodeJS.ProcessEnv;
  /** What the adapter sets. */
  harnessEnv: Record<string, string>;
  /** The adapter's variables that carry a login, taken from `base`. */
  authEnv: string[];
  /** Names the project's config lists in `env`, taken from `base`. */
  pass: string[];
  /** Names the harness must not get, such as the key of the model that scores its answer. They win over everything. */
  withhold: string[];
  /** Executables the run needs on `PATH`: names to look for in a directory, or absolute paths. A `PATH` entry that names this tool is dropped unless it holds one. Default: none. */
  needs?: string[];
  /** What a case sets in its `env`: values given outright, which win over what `base` holds. Default: none. */
  caseEnv?: Record<string, string>;
}

// Variables that no run gets, whatever the config's `env` says. Claude Code names its project directory after this one
// when it is set, so a planted session would not be where the run looks for it.
const NEVER_PASSED = ["CLAUDE_CODE_PROJECT_DIR_NAME"];

/**
 * Builds the environment of a harness process.
 * @param input - Where the home is, what to take from the base, and what to withhold.
 * @returns The allowlisted variables of `base`, the adapter's login variables and the config's `env` names that `base`
 *   has, `HOME` and the XDG directories under the home, the adapter's own variables, and the case's `env` values,
 *   without the withheld names.
 */
export function childEnv(input: ChildEnvInput): Record<string, string> {
  const { home, base, harnessEnv, authEnv, pass, withhold } = input;
  const { caseEnv = {} } = input;
  const named = new Set([...authEnv, ...pass]);
  const inherited = Object.entries(base).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      (ALLOWED.has(entry[0]) || LOCALE.test(entry[0]) || named.has(entry[0])),
  );
  const env = {
    ...Object.fromEntries(inherited),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    ...harnessEnv,
    ...caseEnv,
  };
  const kept = Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !withhold.includes(name) && !NEVER_PASSED.includes(name),
    ),
  );
  const searched = kept["PATH"];
  return searched === undefined
    ? kept
    : { ...kept, PATH: withoutOwnName(searched, input.needs ?? []) };
}

/** The rule for a name in the `env` key of a case, in words. The reference page quotes it. */
const GIT_IDENTITY_NAMES = ["AUTHOR", "COMMITTER"].flatMap((who) =>
  ["NAME", "EMAIL", "DATE"].map((part) => `GIT_${who}_${part}`),
);
const CASE_ENV_RULE =
  "A name must start with `CASE_`, or be `TZ`, `LANG`, `LC_ALL`, or one of the git identity names `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_AUTHOR_DATE`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` and `GIT_COMMITTER_DATE`.";
const CASE_ENV_NAMES = new Set(["TZ", "LANG", "LC_ALL", ...GIT_IDENTITY_NAMES]);
/** The rule for a name in the `env` key of a case, as a regular expression, for the JSON Schema of the case file. */
export const CASE_ENV_PATTERN = `^(CASE_[^=]*|${[...CASE_ENV_NAMES].join("|")})$`;

/**
 * Judges a name of the `env` key of a case.
 * @param name - What the case file sets.
 * @returns Why a case may not set it, or null when it may.
 */
function caseEnvFault(name: string): string | null {
  const fault = envNameFault(name);
  if (fault) return fault;
  return name.startsWith("CASE_") || CASE_ENV_NAMES.has(name)
    ? null
    : CASE_ENV_RULE;
}

/**
 * Judges one entry of the `env` key of a case.
 * @param name - The variable's name.
 * @param setting - The value the case file gives it.
 * @returns What is wrong with the entry, as the end of an error message, or null when it is fine.
 */
export function caseEnvProblem(name: string, setting: unknown): string | null {
  const fault = caseEnvFault(name);
  if (fault) return `cannot set "${name}": ${fault}`;
  return typeof setting === "string" && !setting.includes("\0")
    ? null
    : `"${name}" must be a string without a NUL character`;
}
