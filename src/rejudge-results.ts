import type { Partition } from "./applicability.js";
import type { CaseMeta } from "./case-meta.js";
import type { Case } from "./cases.js";
import type { Check } from "./checks/index.js";
import type { DeltaSetup } from "./evaluate-setup.js";
import type { Results } from "./evaluate.js";
import type { Finished } from "./finish.js";
import { summarize } from "./finish.js";
import { readNoise } from "./noise.js";
import { messageOf } from "./scope.js";
import type { RunRecord } from "./run.js";

/** The fields of a check result that are not the check's own. */
const RESULT_FIELDS = new Set([
  "score",
  "reason",
  "ballots",
  "probabilities",
  "command",
]);

// What a case that `caseMeta` does not list has: nothing.
const NO_META: CaseMeta = {
  base: "",
  variant: null,
  heldout: false,
  extensions: {},
  tags: [],
  targets: [],
  guard: false,
  kind: null,
  description: null,
  reps: null,
  model: null,
  judgeModel: null,
  env: {},
};

/** What the summary of a re-judged command is made from. */
export interface Basis {
  /** The results of the earlier command. */
  source: Results;
  /** Every run, in the order of the source: re-scored, or kept as it was. */
  records: RunRecord[];
  /** The cases that were read from the cases directory and are re-scored, by id, as the cases directory has them now. */
  live: Map<string, Case>;
  /** For each harness id, the case as that harness runs it now, by id; only for the cases in `live`. */
  ran: Record<string, Map<string, Case>>;
  /** Who scored the judged checks now, in words, and its model. */
  judge: {
    label: string;
    model: string | null;
    via: "api" | "harness";
    harness: string | null;
  };
  /** Whether the skill checks were scored under `--lenient`. */
  lenient: boolean;
  /** The hash of each case that was re-scored, by harness id and case id. */
  hashes: Record<string, Record<string, string>>;
}

/**
 * Makes a stand-in for a case whose definition is not at hand: one that is no longer in the cases directory, or that
 * is kept as it was because it changed beyond its checks.
 * @param id - The id that `results.json` keys the case by.
 * @param source - The earlier results, which hold what is left of it: its metadata, weight, bar and check results.
 * @returns A case with that metadata and the checks its first run was scored with. Its files and prompt are empty.
 */
function stubCase(id: string, source: Results): Case {
  const meta = source.caseMeta[id] ?? NO_META;
  const scored = source.suites
    .flatMap((suite) => suite.cases)
    .find((one) => one.id === id) ?? { weight: 1, minScore: undefined };
  // The case's own bar is kept in the comparison, which the stand-in must not lose.
  const minDelta = source.comparison?.harnesses
    .flatMap((one) => one.cases)
    .find((one) => one.id === id)?.minDelta;
  const results = source.records.find((one) => one.caseId === id)?.checks ?? [];
  const checks = results.map((result) =>
    Object.fromEntries(
      Object.entries(result).filter(([name]) => !RESULT_FIELDS.has(name)),
    ),
  ) as unknown as Check[];
  return {
    ...meta,
    id,
    base: meta.base || id,
    prompt: "",
    checks,
    weight: scored.weight,
    minScore: scored.minScore,
    minDelta: minDelta ?? undefined,
    timeoutSeconds: 0,
    requires: [],
    description: meta.description ?? undefined,
    kind: meta.kind ?? undefined,
    reps: meta.reps ?? undefined,
    model: meta.model ?? undefined,
    judgeModel: meta.judgeModel ?? undefined,
    workspaceDir: null,
    graderDir: null,
    setup: [],
    fixtureDirs: [],
    fixtureDir: null,
    homeDir: null,
  };
}

/**
 * Reads the noise file that the earlier command used, when it is still there.
 * @param source - The earlier results.
 * @returns The delta settings of the earlier command; the noise is dropped, with a warning, when its file cannot be read.
 */
function deltaOf(source: Results): DeltaSetup {
  let noise: DeltaSetup["noise"] = null;
  if (source.noiseFile !== null) {
    try {
      noise = { file: source.noiseFile, noise: readNoise(source.noiseFile) };
    } catch (error) {
      console.error(
        `skill-evals: warning: the noise file of the earlier command is not used: ${messageOf(error)}`,
      );
    }
  }
  return {
    minDelta: source.minDelta ?? undefined,
    seed: source.seed,
    ignored: source.minDeltaIgnored,
    noise,
  };
}

/**
 * Gathers the metadata of the earlier command, with what a re-judge changes: the judge's model and the hash of each
 * case that was re-scored.
 * @param basis - The earlier results and the cases that were re-scored.
 * @returns The `meta` of the new results.
 */
const metaOf = (basis: Basis): Results["meta"] => ({
  ...basis.source.meta,
  models: { ...basis.source.meta.models, judge: basis.judge.model },
  lenient: basis.lenient,
  judge: {
    via: basis.judge.via,
    harness: basis.judge.harness,
    model: basis.judge.model,
  },
  caseHashes: Object.fromEntries(
    Object.entries(basis.source.meta.caseHashes).map(([harness, hashes]) => [
      harness,
      { ...hashes, ...basis.hashes[harness] },
    ]),
  ),
});

/**
 * Makes what `summarize` sums up: the earlier command's settings over the new records.
 * @param basis - The earlier results, the records, and the cases that were re-scored.
 * @param cases - The cases in report order.
 * @param parts - What each harness ran.
 * @returns The input of `summarize`.
 */
const finishedOf = (
  basis: Basis,
  cases: Case[],
  parts: Partition,
): Finished => {
  const { source } = basis;
  return {
    subjects: source.subjects,
    selection: {
      chosen: source.harnesses.map((id) => ({ harness: { id } })),
      reason: source.harnessReason,
    },
    judgeHarness: undefined,
    judgeModel: undefined,
    judgeApi: null,
    judgeLabel: basis.judge.label,
    decisionModel: source.decisionModel ?? undefined,
    model: source.model ?? undefined,
    minScore: source.minScore ?? undefined,
    delta: deltaOf(source),
    reps: source.reps,
    cases,
    parts,
    meta: metaOf(basis),
    maxInvalid: source.maxInvalid,
    records: basis.records,
    sourceChanged: source.sourceChanged,
    partial: source.partial,
  };
};

/**
 * Sums up a re-judged command: the earlier command's suites, comparison, bars and lists, over the new records.
 * @param basis - The earlier results, the records, and the cases that were re-scored.
 * @returns The results, the cases in report order, and the cases each harness ran. A case that is not re-scored has the
 *   stand-in that `stubCase` makes. When the earlier command stopped at a limit and nothing is left unrun, the new
 *   results are not partial: the runs that had their judged checks skipped are finished.
 */
export function rejudged(basis: Basis): {
  results: Results;
  cases: Case[];
  applied: Record<string, Case[]>;
} {
  const { source, live } = basis;
  const caseOf = (id: string): Case => live.get(id) ?? stubCase(id, source);
  const cases = Object.keys(source.caseMeta).map(caseOf);
  const applied = Object.fromEntries(
    source.suites.map((suite) => [
      suite.harness,
      suite.cases.map(
        (one) =>
          basis.ran[suite.harness]?.get(one.id) ?? stubCase(one.id, source),
      ),
    ]),
  );
  const parts: Partition = {
    ran: applied,
    notApplicable: source.notApplicable,
    skippedChecks: source.skippedChecks,
  };
  const finished = finishedOf(basis, cases, parts);
  const results = summarize(finished);
  const stopped = source.partial?.reason;
  const done =
    (stopped === "budget" || stopped === "duration") &&
    results.notRun.length === 0;
  return {
    results: done ? summarize({ ...finished, partial: null }) : results,
    cases,
    applied,
  };
}
