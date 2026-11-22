import fs from "node:fs";
import os from "node:os";
import type { Case } from "./cases.js";
import { OWN_NAME, childEnv } from "./env.js";
import type { ChildEnvInput } from "./env.js";
import type { Located } from "./harnesses/index.js";
import type { Harness } from "./harnesses/shared.js";
import { textHits } from "./blinding.js";
import { UsageError } from "./scope.js";

/**
 * Finds the blinding words in what the agent can see of the machine.
 * @param paths - Paths the agent may see, such as the temp directory.
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
      textHits(path, words).map((word) => `the path "${path}" holds "${word}"`),
    ),
    ...envNames.flatMap((name) =>
      textHits(name, words).map(
        (word) => `the variable name ${name} holds "${word}"`,
      ),
    ),
  ];
}

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
    harnesses: input.chosen.map(({ harness, bin }) => ({
      authEnv: harness.authEnv,
      withhold: input.withheldBy(harness),
      bin,
    })),
  });
}

/** What decides what the agent's processes can see of the machine. */
interface RuntimeView {
  words: readonly string[];
  /** What the harnesses get from the user's environment. */
  env: Pick<ChildEnvInput, "base" | "pass" | "caseEnv">;
  /** Each harness's login variables, the names it is never given, and its executable. */
  harnesses: { authEnv: string[]; withhold: string[]; bin: string }[];
}

/**
 * Reads the temp directory as a process that starts in it would.
 * @returns The real path of `TMPDIR`, or of the system's temp directory; the path as given when it does not exist.
 */
function tempDirectory(): string {
  const given = process.env["TMPDIR"] ?? os.tmpdir();
  try {
    return fs.realpathSync(given);
  } catch {
    return given;
  }
}

/** The lines of a finding, and what to do about it. */
type Finding = { lines: string[]; fix: string };

/**
 * Stops a command before any run when the machine would tell the agent that it is being evaluated: a temp directory
 * with a blinding word in its path, a variable name with one, or a variable that names this tool. The environment is
 * built by `childEnv`, as a run builds it, so a `PATH` entry that names this tool is dropped here as it is there. A
 * variable that the user passes on purpose and whose value names this tool is warned about, once.
 * @param view - The words, and the environment each harness gets.
 * @throws {UsageError} Naming every hit and what to change for it.
 */
function requireBlindEnvironment(view: RuntimeView): void {
  const envs = view.harnesses.map((harness) => ({
    harness,
    env: childEnv({
      ...view.env,
      ...harness,
      needs: ["node", harness.bin],
      home: "/home",
      harnessEnv: {},
    }),
  }));
  const named = new Set<string>();
  const passed = new Set<string>();
  for (const { harness, env } of envs) {
    const own = new Set([...harness.authEnv, ...view.env.pass]);
    for (const [name, value] of Object.entries(env)) {
      if (!OWN_NAME.test(`${name}=${value}`)) continue;
      (own.has(name) && !OWN_NAME.test(name) ? passed : named).add(name);
    }
  }
  const findings: Finding[] = [
    {
      lines: scanRuntime(
        [tempDirectory()],
        [...new Set(envs.flatMap(({ env }) => Object.keys(env)))],
        view.words,
      ),
      fix: 'Set TMPDIR to a directory whose path holds none of the blinding words, rename the variable, or set "blindingWords" in the config file to a list without the word.',
    },
    {
      lines: [...named].map(
        (name) => `the variable ${name} names this tool, in its name or value`,
      ),
      fix: "Unset the variable, or change it so that it does not name this tool: the harness gets it as it is.",
    },
  ].filter(({ lines }) => lines.length > 0);
  if (passed.size > 0) {
    console.error(
      `skill-evals: warning: the value of ${[...passed].join(", ")} names this tool, and the agent gets it because you pass it on`,
    );
  }
  if (findings.length === 0) return;
  throw new UsageError(
    `the agent could see that it is being evaluated:\n${findings.map(({ lines }) => lines.map((line) => `  - ${line}`).join("\n")).join("\n")}\n${findings.map(({ fix }) => fix).join("\n")}`,
  );
}
