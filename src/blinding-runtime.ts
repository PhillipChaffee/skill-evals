import os from "node:os";
import type { Case } from "./cases.js";
import { childEnv } from "./env.js";
import type { Harness } from "./harnesses/shared.js";
import type { Located } from "./harnesses/index.js";
import type { ChildEnvInput } from "./env.js";
import { pathHits } from "./blinding.js";
import { TEMP_PREFIXES, UsageError } from "./scope.js";

// What this tool is called, in any spelling an environment variable may use for it.
const OWN_NAME = /skill.?evals?/i;

/**
 * Finds the blinding words in what the agent can see of the machine.
 * @param paths - Paths the agent may see, such as the temp directory and the start of a temp directory's name.
 * @param envNames - Names of the variables the agent's process gets.
 * @param words - The blinding words.
 * @returns One line for each word found, naming the word and where it was found. Empty when there is none.
 */
export function scanRuntime(
  paths: string[],
  envNames: string[],
  words: readonly string[],
): string[] {
  return [
    ...paths.flatMap((path) =>
      pathHits(path, words).map((word) => `the path "${path}" holds "${word}"`),
    ),
    ...envNames.flatMap((name) =>
      pathHits(name, words).map(
        (word) => `the variable name ${name} holds "${word}"`,
      ),
    ),
  ];
}

/**
 * Finds the variables of an environment that name this tool, in the name or in the value.
 * @param env - The environment the agent's process gets.
 * @param own - The names of variables that the user passes on purpose: the harness's login variables and the config's
 *   `env`. Their values are the user's own business, so only their names are looked at.
 * @returns One line for each variable.
 */
const scanOwnName = (env: Record<string, string>, own: string[]): string[] =>
  Object.entries(env)
    .filter(([name, value]) =>
      OWN_NAME.test(own.includes(name) ? name : `${name}=${value}`),
    )
    .map(
      ([name]) =>
        `the variable ${name} names this tool, in its name or its value`,
    );

/**
 * Runs `requireBlindEnvironment` for the harnesses and cases of a command.
 * @param input - What the command settled.
 * @param input.words - The blinding words.
 * @param input.pass - The config's `env`: names of variables that the harnesses get besides the allowlist.
 * @param input.cases - The cases, whose `env` the agent's process gets.
 * @param input.chosen - The harnesses that run.
 * @param input.withheldBy - Names what a harness is never given, such as the key of the model that scores it.
 * @throws {UsageError} As `requireBlindEnvironment` does.
 */
export function requireBlindRun(input: {
  words: readonly string[];
  pass: string[];
  cases: Case[];
  chosen: Located[];
  withheldBy: (harness: Harness) => string[];
}): void {
  requireBlindEnvironment({
    words: input.words,
    env: {
      base: process.env,
      pass: input.pass,
      caseEnv: Object.assign(
        {},
        ...input.cases.map((one) => one.env),
      ) as Record<string, string>,
    },
    harnesses: input.chosen.map(({ harness }) => ({
      authEnv: harness.authEnv,
      withhold: input.withheldBy(harness),
    })),
  });
}

/** What decides what the agent's processes can see of the machine. */
interface RuntimeView {
  words: readonly string[];
  /** What the harnesses get from the user's environment. */
  env: Pick<ChildEnvInput, "base" | "pass" | "caseEnv">;
  /** Each harness's login variables, and the names it is never given. */
  harnesses: { authEnv: string[]; withhold: string[] }[];
}

/**
 * Stops a command before any run when the machine would tell the agent that it is being evaluated: a temp directory
 * with a blinding word in its path, a variable name with one, or a variable that names this tool. This tool's own temp
 * directory names are checked too, and none holds a default word.
 * @param view - The words, and the environment each harness gets.
 * @throws {UsageError} Naming every hit and what to change: `TMPDIR`, `blindingWords` or the variable.
 */
function requireBlindEnvironment(view: RuntimeView): void {
  const envs = view.harnesses.map((harness) => ({
    harness,
    env: childEnv({
      ...view.env,
      ...harness,
      home: "/home",
      harnessEnv: {},
    }),
  }));
  const found = new Set([
    ...scanRuntime(
      [process.env["TMPDIR"] ?? os.tmpdir(), ...TEMP_PREFIXES],
      envs.flatMap(({ env }) => Object.keys(env)),
      view.words,
    ),
    ...envs.flatMap(({ harness, env }) =>
      scanOwnName(env, [...harness.authEnv, ...view.env.pass]),
    ),
  ]);
  if (found.size === 0) return;
  throw new UsageError(
    `the agent could see that it is being evaluated:\n${[...found].map((line) => `  - ${line}`).join("\n")}\nSet TMPDIR to a directory whose path holds none of the blinding words, or set "blindingWords" in the config file to a list without them. A variable that names this tool must not reach the harness: unset it, or take it out of "env".`,
  );
}
