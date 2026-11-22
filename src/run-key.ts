import fs from "node:fs";
import path from "node:path";
import type { Case } from "./cases.js";
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
  const { dir, workspaceDir, graderDir, fixtureDir, homeDir, ...loaded } =
    caseDef;
  const own = [
    dir,
    workspaceDir,
    graderDir,
    fixtureDir,
    homeDir,
    ...loaded.fixtureDirs,
  ];
  const hash = sha256(
    canonical({
      loaded: { ...loaded, fixtureDirs: undefined },
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
 * Names a run by everything that decides its result, so that a later command can tell whether a stored record is the
 * answer to the same question.
 * @param plan - The run: its case, subject, harness, model, rep and scoring settings.
 * @returns The sha256 of the canonical JSON of the case hash, the subject's revision, the harness, the model, the rep,
 *   the tool's version, and the scoring: the judge's harness, API and model, the decision model, `isolated` and
 *   `lenient`. Each of these changes what a run is or how it is scored.
 */
export function runKey(plan: RunPlan): string {
  const { judgeApi, judge } = plan;
  return sha256(
    canonical({
      caseHash: caseHash(plan.caseDef),
      subjectRevision: plan.subject.revision,
      harness: plan.harness.id,
      model: plan.model ?? null,
      rep: plan.rep,
      toolVersion: toolVersion(),
      scoring: {
        judgeHarness: judgeApi ? null : judge.harness.id,
        judgeApi: judgeApi?.kind ?? null,
        judgeModel: (judgeApi ?? judge).model ?? null,
        decisionModel: plan.decisionModel ?? null,
        isolated: plan.isolated ?? false,
        lenient: plan.lenient ?? false,
      },
    }),
  );
}
