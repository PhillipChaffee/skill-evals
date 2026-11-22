import { activeWords, pathLints, pathsUnder } from "./blinding-case.js";
import type { Case } from "./cases.js";
import type { Lint } from "./commands/validate.js";
import type { Snapshot } from "./snapshot.js";
import { messageOf, tempDir } from "./scope.js";
import { prepareRun } from "./workspace.js";

/**
 * Writes the warnings for the paths that a run's setup made.
 * @param caseDef - A loaded case, which may be one variant of a case file.
 * @param seed - The files of the workspace once the setup steps are done.
 * @param words - The blinding words.
 * @returns The warnings for the paths that the case's files do not already have, because `validate` reports those.
 */
function setupLints(
  caseDef: Case,
  seed: Snapshot,
  words: readonly string[],
): Lint[] {
  const own = new Set(
    [...caseDef.fixtureDirs, caseDef.workspaceDir].flatMap(pathsUnder),
  );
  const made = [...seed.keys()].filter((one) => !own.has(one));
  return pathLints(
    { caseId: caseDef.id, area: "the workspace after setup" },
    made,
    activeWords(caseDef, words),
  );
}

/**
 * Runs the setup steps of the cases in a throwaway directory, and looks at the paths they made. This is `validate
 * --deep`: it runs the steps of the suite, which `validate` otherwise never does.
 * @param cases - The loaded cases.
 * @param words - The blinding words.
 * @returns The warnings; a case whose setup fails gets one that says so. Only the first of a case's variants is run.
 */
export async function deepLints(
  cases: Case[],
  words: readonly string[],
): Promise<Lint[]> {
  const lints: Lint[] = [];
  const done = new Set<string>();
  for (const caseDef of cases) {
    if (caseDef.setup.length === 0 || done.has(caseDef.base)) continue;
    done.add(caseDef.base);
    const workspace = tempDir("proj-");
    const home = tempDir("home-");
    try {
      const prepared = await prepareRun(caseDef, {
        workspace: workspace.dir,
        home: home.dir,
      });
      try {
        lints.push(
          ...(prepared.failure === null
            ? setupLints(caseDef, prepared.seed, words)
            : [
                {
                  level: "warning" as const,
                  caseId: caseDef.id,
                  text: `--deep could not scan the paths of setup: ${prepared.failure}`,
                },
              ]),
        );
      } finally {
        prepared.dispose();
      }
    } catch (error) {
      lints.push({
        level: "warning",
        caseId: caseDef.id,
        text: `--deep could not scan the paths of setup ${messageOf(error)}`,
      });
    } finally {
      workspace.dispose();
      home.dispose();
    }
  }
  return lints;
}
