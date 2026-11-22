import type { Case } from "./cases.js";
import type { HistoryMode } from "./history-types.js";
import { canonical, hashTree, sha256 } from "./tree-hash.js";
import { stepOf } from "./turn-spec.js";

const hashes = new WeakMap<Case, string>();

/**
 * Hashes the files of a case that the agent can see: `workspace/`, the shared fixtures, the case's `fixture/` and
 * `home/`. The `grader/` directory is not among them.
 * @param caseDef - The resolved case.
 * @returns The sha256 over the content of each directory, in the order the case layers them; the `mcp/` directory, which
 *   the agent's tools answer from, is last.
 */
function seenFiles(caseDef: Case): string {
  const known = hashes.get(caseDef);
  if (known !== undefined) return known;
  const dirs = [
    ...caseDef.fixtureDirs,
    caseDef.workspaceDir,
    caseDef.fixtureDir,
    caseDef.homeDir,
    // Only a case with mock MCP servers has the entry, so that the hash of any other case stays what it was.
    ...(caseDef.mcp ? [caseDef.mcp.dir] : []),
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
 * @param run.historyMode - How the case's history reached the agent (`recordedMode`); only a case with a history uses it.
 * @returns The sha256 over the prompt, the content of `workspace/`, the shared fixtures, the case's `fixture/` and
 *   `home/`, `mcp/` (when the case has one), the setup steps, the harness, the model, `maxTurns` and the names of the case's `env`; for a case with
 *   `turns`, also each turn's text, invocation or event, so that a changed turn prompt file changes it; for a case with
 *   a `history.json` its messages and the mode, and for one with `sessions/` its sessions. The checks,
 *   the rubrics and `grader/` are not in it.
 */
export function inputHash(
  caseDef: Case,
  run: {
    harness: string;
    model: string | undefined;
    historyMode?: HistoryMode | null | undefined;
  },
): string {
  return sha256(
    canonical({
      prompt: caseDef.prompt,
      // Only a case with turns has the key, so that the hash of a single prompt stays what it was.
      ...(caseDef.turns && {
        turns: caseDef.turns.map(stepOf),
      }),
      // Only a case with a history or sessions has these keys, so that the hash of any other case stays what it was.
      ...(caseDef.history && {
        history: caseDef.history,
        historyMode: run.historyMode ?? null,
      }),
      ...(caseDef.sessions && { sessions: caseDef.sessions }),
      files: seenFiles(caseDef),
      setup: caseDef.setup,
      harness: run.harness,
      model: caseDef.model ?? run.model ?? null,
      maxTurns: caseDef.maxTurns ?? null,
      envNames: Object.keys(caseDef.env).sort(),
    }),
  );
}
