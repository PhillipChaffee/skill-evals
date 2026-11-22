import fs from "node:fs";
import path from "node:path";
import type { Case } from "./cases.js";
import { recordedMode } from "./history.js";
import type { RunPlan } from "./run-plan.js";
import { canonical, hashTree, sha256 } from "./tree-hash.js";

const caseHashes = new WeakMap<Case, string>();

/**
 * Hashes a case as a run sees it.
 * @param caseDef - The resolved case, a variant included.
 * @returns The sha256 over the case as loaded (without the paths it was loaded from) and over every file of the case's
 *   directory, of the shared fixtures it uses and of its grader: sorted relative paths and bytes, a link by its target
 *   text. It does not depend on where the checkout is.
 */
export function caseHash(caseDef: Case): string {
  const known = caseHashes.get(caseDef);
  if (known !== undefined) return known;
  // `mcp` holds a path, so it stays out of the loaded case; its directory is hashed by content below, as `dir` is.
  const { dir, workspaceDir, graderDir, fixtureDir, homeDir, mcp, ...loaded } =
    caseDef;
  // A case with one prompt has no `turns` key, so its hash is what it was before turns existed.
  const { turns, ...rest } = loaded;
  const own = [
    dir,
    workspaceDir,
    graderDir,
    fixtureDir,
    homeDir,
    ...loaded.fixtureDirs,
    mcp?.dir,
  ];
  const hash = sha256(
    canonical({
      loaded: { ...rest, fixtureDirs: undefined, ...(turns && { turns }) },
      files: own.flatMap((each) =>
        each === undefined || each === null ? [] : [hashTree(each)],
      ),
    }),
  );
  caseHashes.set(caseDef, hash);
  return hash;
}

let version: string | undefined;

/**
 * Reads the version of this package.
 * @returns The `version` of `package.json`, which lies one directory above `src` and above `dist`.
 */
export function toolVersion(): string {
  version ??= (
    JSON.parse(
      fs.readFileSync(
        path.join(import.meta.dirname, "../package.json"),
        "utf8",
      ),
    ) as { version: string }
  ).version;
  return version;
}

/**
 * Describes the executable of a harness, so that a self-update of the harness changes the key.
 * @param bin - The path of the executable.
 * @returns Its real path, size and modification time; null when it cannot be read.
 */
function binOf(
  bin: string,
): { realpath: string; size: number; mtimeMs: number } | null {
  try {
    const realpath = fs.realpathSync(bin);
    const { size, mtimeMs } = fs.statSync(realpath);
    return { realpath, size, mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Describes the variables that the config passes to the harness.
 * @param names - The names in the config's `env`.
 * @returns Each name, in order, with the sha256 of its value in this process; a variable that is not set hashes as unset.
 */
const passedEnv = (
  names: string[] | undefined,
): Record<string, string | null> =>
  Object.fromEntries(
    [...(names ?? [])].sort().map((name) => {
      const value = process.env[name];
      return [name, value === undefined ? null : sha256(value)];
    }),
  );

/**
 * Names a run by everything that decides its result, so that a later command can tell whether a stored record is the
 * answer to the same question.
 * @param plan - The run: its case, subject, harness, model, rep and scoring settings.
 * @returns The sha256 of the canonical JSON of the case hash, the subject's revision, the harness and its executable
 *   (real path, size, modification time), the model, for a case with a history the mode it reaches the agent in, the rep, the tool's version (the package version, so a rebuilt
 *   tool with the same version shares keys), the names and value hashes of the passed variables, and the scoring: the
 *   judge's harness, its executable when it is not the harness under test, API, URL, fallbacks and model, the decision model and URL, `isolated` and `lenient`. Each of these changes what a run is or how it is scored.
 */
export function runKey(plan: RunPlan): string {
  const { judgeApi, judge } = plan;
  return sha256(
    canonical({
      caseHash: caseHash(plan.caseDef),
      subjectRevision: plan.subject.revision,
      harness: plan.harness.id,
      // Only a revision above the first has the key, so that the key of an earlier run stays what it was.
      ...(plan.harness.argvRevision > 1 && {
        argvRevision: plan.harness.argvRevision,
      }),
      // Only a subject that names rules has the key, so that the key of any other run stays what it was.
      ...(plan.subject.rules && { rules: plan.subject.rules }),
      // Only a subject with options has the key. `rules=on` and `rules=off` leave the export as it is, so the options
      // text is what tells the two runs apart.
      ...(plan.subject.options !== "" && { options: plan.subject.options }),
      model: plan.model ?? null,
      // Only a case with a history has the key, so that the key of any other run stays what it was.
      ...(plan.caseDef.history && {
        historyMode: recordedMode({ ...plan, forced: plan.historyMode }),
      }),
      rep: plan.rep,
      toolVersion: toolVersion(),
      harnessBin: binOf(plan.bin),
      env: passedEnv(plan.pass),
      scoring: {
        judgeHarness: judgeApi ? null : judge.harness.id,
        judgeBin:
          judgeApi || judge.harness.id === plan.harness.id
            ? null
            : binOf(judge.bin),
        judgeApi: judgeApi?.kind ?? null,
        judgeUrl: judgeApi?.url ?? null,
        judgeFallbacks: judgeApi?.fallbacks ?? null,
        decisionUrl: plan.decisionUrl ?? null,
        judgeModel: (judgeApi ?? judge).model ?? null,
        decisionModel: plan.decisionModel ?? null,
        isolated: plan.isolated ?? false,
        lenient: plan.lenient ?? false,
      },
    }),
  );
}
