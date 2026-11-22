import type { Case } from "./cases.js";
import { canonical, hashTree, sha256 } from "./tree-hash.js";

const hashes = new WeakMap<Case, string>();

/**
 * Hashes the files of a case that the agent can see: `workspace/`, the shared fixtures, the case's `fixture/` and
 * `home/`. The `grader/` directory is not among them.
 * @param caseDef - The resolved case.
 * @returns The sha256 over the content of each directory, in the order the case layers them.
 */
function seenFiles(caseDef: Case): string {
  const known = hashes.get(caseDef);
  if (known !== undefined) return known;
  const dirs = [
    ...caseDef.fixtureDirs,
    caseDef.workspaceDir,
    caseDef.fixtureDir,
    caseDef.homeDir,
  ];
  const hash = sha256(
    canonical(dirs.map((dir) => (dir === null ? null : hashTree(dir)))),
  );
  hashes.set(caseDef, hash);
  return hash;
}

/**
 * Hashes what the agent sees of a run, so that a later command can tell a case whose checks changed from one whose
 * question changed.
 * @param caseDef - The resolved case, a variant included.
 * @param run - Who answers the case.
 * @param run.harness - The id of the harness under test.
 * @param run.model - The model of the run: the case's own `model`, else the command's.
 * @returns The sha256 over the prompt, the content of `workspace/`, the shared fixtures, the case's `fixture/` and
 *   `home/`, the setup steps, the harness, the model, `maxTurns` and the names of the case's `env`. The checks, the
 *   rubrics and `grader/` are not in it.
 */
export function inputHash(
  caseDef: Case,
  run: { harness: string; model: string | undefined },
): string {
  return sha256(
    canonical({
      prompt: caseDef.prompt,
      files: seenFiles(caseDef),
      setup: caseDef.setup,
      harness: run.harness,
      model: caseDef.model ?? run.model ?? null,
      maxTurns: caseDef.maxTurns ?? null,
      envNames: Object.keys(caseDef.env).sort(),
    }),
  );
}
