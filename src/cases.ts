import fs from "node:fs";
import path from "node:path";
import type { Need } from "./capabilities.js";
import type { Mode } from "./checks/fields.js";
import { extensionsOf } from "./checks/extensions.js";
import { readField } from "./checks/fields.js";
import type { Check } from "./checks/index.js";
import { readCheck } from "./checks/index.js";
import type { Found } from "./discover.js";
import { declaresVariants, discover } from "./discover.js";
import { baseGlobOf, globToRegExp, mayReachVariantOf } from "./glob.js";
import { graderOf, workspaceOf } from "./case-dirs.js";
import { CASE_KEYS } from "./case-keys.js";
import { layersOf } from "./case-layers.js";
import { limitsOf } from "./case-limits.js";
import type { OnTimeout } from "./session-end.js";
import { SCHEMA_KEY, checkSchemaKey } from "./schema-key.js";
import { UsageError, messageOf } from "./scope.js";
import type { SetupStep } from "./setup-steps.js";
import type { Turn } from "./turn-spec.js";
import { readTurns, taskOf } from "./turn-spec.js";
import { readVariants } from "./variants.js";
import type { Resolved } from "./variants.js";

/** One prompt and what a good run of it does. */
export interface Case {
  /** What `--case` selects and results are keyed by: the case's path, or `<path>@<variant>` for a variant. */
  id: string;
  /** The case's path, which a variant shares with its case. Equal to `id` for a case without variants. */
  base: string;
  /** The variant's id, or null for a case without variants. */
  variant: string | null;
  /** True for a variant that runs only with `--heldout`. */
  heldout: boolean;
  /** What the user says: `prompt.md`, or for a case with `turns` the turns written as one text (see `taskOf`). */
  prompt: string;
  /** The user's turns, in order; null for a case with one prompt. */
  turns: Turn[] | null;
  checks: Check[];
  weight: number;
  minScore?: number | undefined;
  /** The most main-thread turns the agent may take; the runner stops the run as the next one begins. Absent: no limit. */
  maxTurns?: number | undefined;
  timeoutSeconds: number;
  /** The seconds the whole run of a case with `turns` may take. Absent: `timeoutSeconds` times the number of turns. */
  totalTimeoutSeconds?: number | undefined;
  /** What a run that hits `timeoutSeconds` is: invalid (the default), or scored on what it left. */
  onTimeout?: OnTimeout | undefined;
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
  /**
   * The case's `grader/` directory, or null. It is never copied before the agent runs. After the agent exits a
   * `command` check reaches a copy of it through `SKILL_EVALS_GRADER_DIR`.
   */
  graderDir: string | null;
  /** Steps that run in the workspace after the files are copied and before the agent starts. */
  setup: SetupStep[];
  /** The shared fixture directories that `fixtures` names, absolute, in the order they are layered. */
  fixtureDirs: string[];
  /** The case's `fixture/` directory, which only setup steps see, or null. */
  fixtureDir: string | null;
  /** The directory that `home` names, copied into the run's throwaway home, or null. */
  homeDir: string | null;
  /** The keys of the case file that start with `x-`, which belong to the case's author. */
  extensions: Record<string, unknown>;
  /** The case's directory; set by the loader. A reused result is tied to its content (`runKey`). */
  dir?: string | undefined;
}

export { CASE_KEYS } from "./case-keys.js";

const DEFAULT_TIMEOUT_SECONDS = 600;

/** Reads one key of a case file with its type's parser; undefined when the file leaves the key out. */
type Read = (key: string) => unknown;

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
 * Reads the files of a case directory.
 * @param found - The case's id and its directory.
 * @returns What `prompt.md` holds, or null when the case has no such file, and the parsed case file.
 * @throws {UsageError} When a file cannot be read, is not JSON, or `prompt.md` is empty; when no prompt source exists.
 */
function readFiles(found: Found) {
  const { id, dir } = found;
  const promptFile = path.join(dir, "prompt.md");
  try {
    const prompt = fs.existsSync(promptFile)
      ? fs.readFileSync(promptFile, "utf8").trim()
      : null;
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, "case.json"), "utf8"),
    ) as Record<string, unknown> | null | undefined;
    return { prompt, raw };
  } catch (error) {
    throw new UsageError(`case ${id}: ${messageOf(error)}`);
  }
}

/** What every variant of a case shares, and the case's own id. */
type Shared = Omit<
  Case,
  "id" | "base" | "variant" | "heldout" | "prompt" | "turns" | "extensions"
>;

/**
 * Makes the cases of one case file.
 * @param whole - The case's id, the keys that start with `x-`, and what all its variants share.
 * @param whole.id - The case's path.
 * @param whole.extensions - The keys of the case file that start with `x-`.
 * @param whole.shared - Everything but the prompt, the id and what a variant decides.
 * @param whole.turns - The case's own turns, or null; set when there are no variants.
 * @param variants - The variants with their whole prompts, or undefined for a case that has none.
 * @param prompt - What `prompt.md` holds; set when there are no variants.
 * @returns One case, or one case for each variant.
 */
function expand(
  whole: {
    id: string;
    extensions: Record<string, unknown>;
    shared: Shared;
    turns: Turn[] | null;
  },
  variants: Resolved[] | undefined,
  prompt: string | null,
): Case[] {
  const { id, extensions, shared, turns } = whole;
  if (variants === undefined) {
    const bare = { id, base: id, variant: null, heldout: false };
    const task = turns ? taskOf(turns) : (prompt ?? "");
    return [{ ...shared, ...bare, prompt: task, turns, extensions }];
  }
  return variants.map((variant) => ({
    ...shared,
    id: `${id}@${variant.id}`,
    base: id,
    variant: variant.id,
    heldout: variant.heldout,
    prompt: variant.prompt,
    turns: variant.turns ?? null,
    tags: [...new Set([...shared.tags, ...variant.tags])],
    extensions: { ...extensions, ...variant.extensions },
  }));
}

/**
 * Checks that a case has one source for what the user says.
 * @param id - The case's id, for the messages.
 * @param found - What the case has: the text of `prompt.md` (null when there is none), and whether it has `turns` and `variants`.
 * @param found.prompt - What `prompt.md` holds, or null.
 * @param found.hasTurns - Whether the case file has `turns`.
 * @param found.hasVariants - Whether the case file has `variants`.
 * @throws {UsageError} When `prompt.md` and `turns` are both set; and, for a case without variants, when `prompt.md` is
 *   empty or missing and there are no turns. With variants, `prompt.md` matters only to a variant that appends to it.
 */
function requirePromptSource(
  id: string,
  found: { prompt: string | null; hasTurns: boolean; hasVariants: boolean },
): void {
  const { prompt, hasTurns, hasVariants } = found;
  if (hasTurns && prompt !== null) {
    throw new UsageError(
      `case ${id}: prompt.md and "turns" are both set; a case has one prompt source`,
    );
  }
  if (hasVariants || hasTurns) return;
  if (prompt === "") throw new UsageError(`case ${id}: prompt.md is empty`);
  if (prompt === null) {
    throw new UsageError(
      `case ${id}: no prompt source; add a prompt.md, or list "turns"`,
    );
  }
}

/**
 * Loads one case from its directory.
 * @param found - The case's id and its directory, which holds `prompt.md`, `case.json`, and an optional `workspace/`.
 * @param mode - Whether a key that the case file does not take is an error or is dropped with a warning.
 * @param root - The cases directory.
 * @returns The case, read and checked against the tables of keys and checks: one case, or one for each of its variants.
 * @throws {UsageError} When a file is missing or does not hold a valid case.
 */
function loadCase(found: Found, mode: Mode, root: string): Case[] {
  const { id, dir } = found;
  const file = path.join(dir, "case.json");
  const { prompt, raw } = readFiles(found);
  const hasTurns = raw?.["turns"] !== undefined;
  requirePromptSource(id, {
    prompt,
    hasTurns,
    hasVariants: raw?.["variants"] !== undefined,
  });
  const checks = raw?.["checks"];
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new UsageError(`${file}: "checks" must be a non-empty array`);
  }
  const at = { where: file, owner: "a case", siblings: raw ?? {} };
  checkSchemaKey(file, at.siblings);
  const extensions = extensionsOf(
    [...Object.keys(CASE_KEYS), SCHEMA_KEY],
    at,
    mode,
  );
  // A null weight counts as none, as it did before keys were typed.
  const read: Read = (key) =>
    raw?.[key] === undefined || (key === "weight" && raw[key] === null)
      ? undefined
      : readField(CASE_KEYS, key, at);
  const workspaceDir = path.join(dir, "workspace");
  const shared = {
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
    dir,
    workspaceDir: workspaceOf(workspaceDir, file),
    graderDir: graderOf(dir, file),
    ...layersOf(found, read, root),
  };
  const variants = read("variants") as Record<string, unknown>[] | undefined;
  const turns = hasTurns
    ? readTurns(read("turns") as Record<string, unknown>[], {
        file,
        dir,
        mode,
      })
    : null;
  return expand(
    { id, extensions, shared, turns },
    variants && readVariants(variants, prompt, { file, dir, mode }),
    prompt,
  );
}

/** What loading cases takes besides the directory. */
export interface LoadOptions {
  /** Drop a key that a case file does not take instead of failing. Default: false. */
  lenient?: boolean;
  /** Called with a line of text, and the id of its case, for each key that `lenient` drops. */
  onWarning?: (text: string, caseId: string) => void;
  /** Collecting mode: hears of a fault (case id or directory, message), skips that case and goes on. Absent: throws. */
  onError?: (caseId: string, message: string) => void;
}

/**
 * Loads the cases whose ids a test accepts. A case that the test rejects is never read, so a fault in it is no error.
 * @param casesDir - The directory to search at any depth.
 * @param keep - Decides from a case's id and directory whether to load it.
 * @param options - How to treat unknown keys.
 * @returns The cases, sorted by id.
 * @throws {UsageError} When the directory cannot be read, or a case is invalid.
 */
export function loadWhere(
  casesDir: string,
  keep: (id: string, dir: string) => boolean,
  options: LoadOptions,
): Case[] {
  const warn =
    options.onWarning ??
    ((text: string) => {
      console.error(`skill-evals: warning: ${text}`);
    });
  return discover(casesDir, [], options.onError)
    .filter(({ id, dir }) => keep(id, dir))
    .flatMap((found) => {
      const mode: Mode = {
        lenient: options.lenient ?? false,
        warn: (text) => {
          warn(text, found.id);
        },
      };
      try {
        return loadCase(found, mode, casesDir);
      } catch (error) {
        if (!options.onError || !(error instanceof UsageError)) throw error;
        options.onError(found.id, error.message);
        return [];
      }
    })
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
 * @returns Every matching case, sorted by id: a case with variants comes as one case for each variant, held-out ones
 *   included (`heldout` is true on them), under the id `<case id>@<variant id>`. A glob matches a variant by that
 *   id or by the case's id.
 * @throws {UsageError} When the directory cannot be read, a case is invalid, or no case matches.
 */
export function loadCases(
  casesDir: string,
  glob = "**",
  options: LoadOptions = {},
): Case[] {
  const matcher = globToRegExp(glob);
  // A glob that names a variant is tried on the case's path by its part before the `@`.
  const bases = globToRegExp(baseGlobOf(glob));
  const cases = loadWhere(
    casesDir,
    (id, dir) =>
      bases.test(id) || (mayReachVariantOf(glob, id) && declaresVariants(dir)),
    options,
  ).filter((one) => matcher.test(one.id) || matcher.test(one.base));
  if (cases.length === 0) {
    throw new UsageError(`no case in ${casesDir} matches "${glob}"`);
  }
  return cases;
}
