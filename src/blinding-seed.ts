import { activeWords, pathLints } from "./blinding-case.js";
import type { Case } from "./cases.js";
import type { Snapshot } from "./snapshot.js";

/** What a command remembers of the blinding words it checks the seeds against. */
export interface SeedBlinding {
  words: readonly string[];
  /** The cases that were already warned about, by path: a case's variants and reps share one seed's paths. */
  warned: Set<string>;
}

/**
 * Warns about blinding words in the paths of the workspace a run really started with, which includes what the setup
 * steps made. It says so once for each case in a command.
 * @param caseDef - The case that the run is of.
 * @param seed - The workspace's files when the harness was about to start.
 * @param blinding - The words and what was already said; undefined checks nothing.
 */
export function warnSeed(
  caseDef: Case,
  seed: Snapshot,
  blinding: SeedBlinding | undefined,
): void {
  if (blinding === undefined || blinding.warned.has(caseDef.base)) return;
  blinding.warned.add(caseDef.base);
  for (const { text } of pathLints(
    { caseId: caseDef.id, area: "the workspace the run started with" },
    [...seed.keys()],
    activeWords(caseDef, blinding.words),
  )) {
    console.error(`skill-evals: warning: ${caseDef.id}: ${text}`);
  }
}
