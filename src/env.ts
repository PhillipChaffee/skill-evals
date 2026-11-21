import path from "node:path";
import { UsageError } from "./scope.js";

// What a harness needs to run at all, to reach the network through a proxy, and to trust the same certificates as the
// user's shell. Nothing else of this process's environment is inherited.
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
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
]);
const LOCALE = /^LC_/;
// This tool's own variables, and the ones npm and the shell set that name the command that is running.
const NAMES_THIS_TOOL = /^(SKILL_EVALS_|npm_|_$)/;

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
  /** What a case sets in its `env`: values given outright, which win over what `base` holds. Default: none. */
  caseEnv?: Record<string, string>;
}

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
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !withhold.includes(name)),
  );
}

/** The rule for a name in the `env` key of a case, in words. The reference page quotes it. */
export const CASE_ENV_RULE =
  "A name must start with `CASE_`, or be `TZ`, `LANG` or `LC_ALL`.";
const CASE_ENV_NAMES = new Set(["TZ", "LANG", "LC_ALL"]);

/**
 * Judges a name of the `env` key of a case.
 * @param name - What the case file sets.
 * @returns Why a case may not set it, or null when it may.
 */
export function caseEnvFault(name: string): string | null {
  const fault = envNameFault(name);
  if (fault) return fault;
  return name.startsWith("CASE_") || CASE_ENV_NAMES.has(name)
    ? null
    : CASE_ENV_RULE;
}
