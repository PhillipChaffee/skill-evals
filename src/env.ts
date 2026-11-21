import path from "node:path";

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
}

/**
 * Builds the environment of a harness process.
 * @param input - Where the home is, what to take from the base, and what to withhold.
 * @returns The allowlisted variables of `base`, the adapter's login variables and the config's `env` names that `base`
 *   has, `HOME` and the XDG directories under the home, and the adapter's own variables, without the withheld names.
 */
export function childEnv(input: ChildEnvInput): Record<string, string> {
  const { home, base, harnessEnv, authEnv, pass, withhold } = input;
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
  };
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !withhold.includes(name)),
  );
}
