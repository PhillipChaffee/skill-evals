import { UsageError } from "./scope.js";

/** The built-in git step: what a case needs to start in a repository. */
interface GitStep {
  /** Run `git init -q -b <branch>`. */
  init?: boolean | undefined;
  /** The branch `init` creates. Default: `main`. Needs `init: true`. */
  branch?: string | undefined;
  /** Run `git add -A && git commit -q -m <this>`. */
  commitAll?: string | undefined;
  /** Create a bare repository `<remote>.git` in the run's remote directory, add it as this remote and push to it. */
  remote?: string | undefined;
}

/** One step of a case's `setup`: a shell command, or the built-in git shortcut. */
export type SetupStep =
  { run: string; timeoutSeconds?: number | undefined } | { git: GitStep };

/** The seconds a step may take when it does not say. */
export const DEFAULT_STEP_SECONDS = 60;

const GIT_KEYS = ["init", "branch", "commitAll", "remote"];
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const REMOTE = /^[A-Za-z0-9_-]+$/;
const SAFE_WORD = /^[A-Za-z0-9_./-]+$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Quotes a word for `/bin/sh`.
 * @param word - Any text.
 * @returns The word as it is when it holds only safe characters, else in single quotes.
 */
const quoted = (word: string): string =>
  SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * Reads the `git` object of a step.
 * @param git - The value of the key.
 * @param fail - Builds the error for this step.
 * @returns The git step.
 * @throws {UsageError} For an unknown key, a value of the wrong type, or a `branch` without `init`.
 */
function readGit(git: unknown, fail: (problem: string) => UsageError) {
  if (!isObject(git) || Object.keys(git).length === 0) {
    throw fail(`"git" needs at least one of ${GIT_KEYS.join(", ")}`);
  }
  const unknown = Object.keys(git).find((key) => !GIT_KEYS.includes(key));
  if (unknown !== undefined) throw fail(`git: unknown key "${unknown}"`);
  const { init, branch, commitAll, remote } = git;
  if (init !== undefined && typeof init !== "boolean") {
    throw fail("git.init must be true or false");
  }
  if (branch !== undefined && init !== true) {
    throw fail('git.branch needs "init": true');
  }
  if (
    branch !== undefined &&
    !(typeof branch === "string" && BRANCH.test(branch))
  ) {
    throw fail("git.branch must be a branch name: letters, digits, . _ / -");
  }
  if (
    commitAll !== undefined &&
    !(typeof commitAll === "string" && commitAll !== "")
  ) {
    throw fail("git.commitAll must be a non-empty string");
  }
  if (
    remote !== undefined &&
    !(typeof remote === "string" && REMOTE.test(remote))
  ) {
    throw fail(
      'git.remote must be a remote name: letters, digits, "-" and "_"',
    );
  }
  return git as GitStep;
}

/**
 * Reads one step.
 * @param step - One entry of the `setup` list, as parsed.
 * @param fail - Builds the error for this step.
 * @returns The checked step, ready to run.
 * @throws {UsageError} When it is not one valid step.
 */
function readStep(
  step: unknown,
  fail: (problem: string) => UsageError,
): SetupStep {
  if (!isObject(step)) throw fail("must be an object");
  const hasRun = "run" in step;
  if (hasRun === "git" in step) {
    throw fail('must have exactly one of "run" and "git"');
  }
  const allowed = hasRun ? ["run", "timeoutSeconds"] : ["git"];
  const unknown = Object.keys(step).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw fail(`unknown key "${unknown}"`);
  if (!hasRun) return { git: readGit(step["git"], fail) };
  const { run, timeoutSeconds } = step;
  if (typeof run !== "string" || run === "") {
    throw fail('"run" must be a non-empty string');
  }
  if (
    timeoutSeconds !== undefined &&
    !(Number.isInteger(timeoutSeconds) && (timeoutSeconds as number) > 0)
  ) {
    throw fail('"timeoutSeconds" must be a positive integer');
  }
  return { run, timeoutSeconds: timeoutSeconds as number | undefined };
}

/**
 * Reads the `setup` key of a case file.
 * @param value - The parsed value.
 * @param where - The case file, for the messages.
 * @returns The steps, in order.
 * @throws {UsageError} Naming the step, counted from 1, when the value is not a non-empty list of valid steps.
 */
export function readSteps(value: unknown, where: string): SetupStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new UsageError(`${where}: "setup" must be a non-empty list of steps`);
  }
  return value.map((step: unknown, index) =>
    readStep(
      step,
      (problem) =>
        new UsageError(
          `${where}: setup step ${String(index + 1)}${problem.startsWith("must") ? " " : ": "}${problem}`,
        ),
    ),
  );
}

/**
 * Writes a step as the shell text that runs it.
 * @param step - A step of a case's `setup`.
 * @returns A `run` step's text as it is. A `git` step is its parts, in this order and joined with `&&`: `git init -q
 *   -b <branch>`, `git add -A`, `git commit -q -m <commitAll>`, and for a remote a bare repository in
 *   `$SKILL_EVALS_REMOTE_DIR`, `git remote add`, and `git push -q -u <remote> HEAD`.
 */
export function stepCommand(step: SetupStep): string {
  if ("run" in step) return step.run;
  const { init, branch, commitAll, remote } = step.git;
  const bare = remote && `"$SKILL_EVALS_REMOTE_DIR/${remote}.git"`;
  return [
    init ? `git init -q -b ${quoted(branch ?? "main")}` : null,
    commitAll === undefined
      ? null
      : `git add -A && git commit -q -m ${quoted(commitAll)}`,
    remote
      ? `git init -q --bare ${String(bare)} && git remote add ${remote} ${String(bare)} && git push -q -u ${remote} HEAD`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" && ");
}
