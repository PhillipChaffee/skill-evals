import type { Case } from "./cases.js";

/** What `results.json` keeps of a case file besides its checks. A key the file leaves out is null, or empty for a list. */
export interface CaseMeta {
  /** The keys that start with `x-`, which belong to the case's author. */
  extensions: Record<string, unknown>;
  tags: string[];
  targets: string[];
  guard: boolean;
  kind: string | null;
  description: string | null;
  /** The case's own `reps`, `model` and `judgeModel`, which win over the command's. */
  reps: number | null;
  model: string | null;
  judgeModel: string | null;
  /** The variables the case sets for the agent. */
  env: Record<string, string>;
}

/**
 * Picks what `results.json` keeps of a case.
 * @param caseDef - The loaded case.
 * @returns Its metadata.
 */
export const metaOf = (caseDef: Case): CaseMeta => ({
  extensions: caseDef.extensions,
  tags: caseDef.tags,
  targets: caseDef.targets,
  guard: caseDef.guard,
  kind: caseDef.kind ?? null,
  description: caseDef.description ?? null,
  reps: caseDef.reps ?? null,
  model: caseDef.model ?? null,
  judgeModel: caseDef.judgeModel ?? null,
  env: caseDef.env,
});
