import { openCache, scopedCache } from "./cache.js";
import type { Cache } from "./cache.js";
import type { Case } from "./cases.js";
import { describeCheck, isJudged } from "./checks/index.js";
import type { DecisionService } from "./decision.js";
import { decisionFor } from "./evaluate-setup.js";
import { judgeText } from "./finish.js";
import { HARNESSES, findBin } from "./harnesses/index.js";
import type { Located } from "./harnesses/index.js";
import type { Harness } from "./harnesses/shared.js";
import type { JudgeApi } from "./judge-api.js";
import { judgeHarnessOf, judgeSetup } from "./judge-config.js";
import type { Plan } from "./rejudge-plan.js";
import type { Source } from "./rejudge-source.js";
import type { Results } from "./evaluate.js";
import type { RunMeta } from "./meta.js";
import { NO_ARCHIVE, rescore } from "./rescore.js";
import type { Config } from "./project.js";
import type { RunRecord } from "./run.js";
import type { Judge } from "./run-plan.js";
import { UsageError, messageOf } from "./scope.js";
import { formatScore } from "./score.js";
import { slotName, stemOf } from "./store.js";
import type { Options } from "./usage.js";

/** What re-scoring made. */
export interface Rescored {
  /** Every run in the order of the earlier results: re-scored, or as it was. */
  records: RunRecord[];
  /** Who scored the judged checks, in words, and its model. */
  judge: {
    label: string;
    model: string | null;
    via: "api" | "harness";
    harness: string | null;
  };
  /** Whether the skill checks were scored under `--lenient`. */
  lenient: boolean;
  /** One line for each run or check that was not re-scored, and why. */
  notes: string[];
}

/** The options that re-scoring reads, after the config file was applied. */
type Merged = Config & Options & { cases: string };

/** Who scores the judged and decision checks of this command. */
interface Judging {
  judgeApi: JudgeApi | null;
  judgeModel: string | undefined;
  judgeHarness: Located | undefined;
  decision: DecisionService | null;
}

const runName = (record: RunRecord): string =>
  `${record.harness} ${record.caseId} ${record.subject}${String(record.rep)}`;

/**
 * Finds the adapter of a harness that an earlier command ran.
 * @param id - The id that the earlier results name the harness by.
 * @returns The adapter.
 * @throws {UsageError} When this version knows no such harness.
 */
export function harnessOf(id: string): Harness {
  const found = HARNESSES.find((one) => one.id === id);
  if (found === undefined) {
    throw new UsageError(
      `the results name the harness ${id}, which this version does not know`,
    );
  }
  return found;
}

type Recorded = NonNullable<RunMeta["judge"]>;

/**
 * Reads how the earlier command scored its judged checks.
 * @param results - The earlier results.
 * @returns `meta.judge`; for results that lack it, what their `judge` text says.
 */
function recordedJudge(results: Results): Recorded {
  if (results.meta.judge !== undefined) return results.meta.judge;
  const modelOf = (text: string | undefined): string | null =>
    text === undefined || text === "the harness default" ? null : text;
  const api = /^the (\w+) API, model (.*)$/.exec(results.judge);
  if (api !== null) {
    return { via: "api", harness: null, model: modelOf(api[2]) };
  }
  const named = /^(.+), model (.*)$/.exec(results.judge);
  return {
    via: "harness",
    harness:
      named?.[1] === "the harness under test" ? null : (named?.[1] ?? null),
    model: modelOf(named?.[2]),
  };
}

/**
 * Settles the decision model once, for the request and for the cache key. `rejudge` has no flag for it.
 * @param source - The earlier command's results, which record the decision model.
 * @param options - The options after the config file was applied.
 * @returns The recorded model, else the config's.
 */
const decisionModelOf = (source: Source, options: Merged): string | undefined =>
  source.results.decisionModel ?? options.decisionModel;

/**
 * Settles who judges, once the cases that are re-scored are known, before any harness starts. The default is the way
 * the earlier command judged; a flag replaces it, with one warning, because the judge cache answers only the same judge.
 * @param source - The earlier command's results, whose judge and decision model are the defaults.
 * @param cases - The cases that are re-scored.
 * @param options - The options after the config file was applied.
 * @returns The judge API (null for a harness session), the judge's model, the judge harness, and the decision model's
 *   service.
 * @throws {UsageError} When the judge API or the decision model is not set up for a case that needs it.
 */
function judgingOf(source: Source, cases: Case[], options: Merged): Judging {
  const { results } = source;
  const recorded = recordedJudge(results);
  const config: Config & { cases: string } = options;
  const judging: Config = { ...config };
  if (results.model !== null) judging.model = results.model;
  const api =
    options.judgeApi ?? (recorded.via === "api" ? "anthropic" : undefined);
  const harness =
    options.judgeHarness ??
    (api === undefined ? (recorded.harness ?? undefined) : undefined);
  delete judging.judgeApi;
  delete judging.judgeHarness;
  if (api !== undefined) judging.judgeApi = api;
  if (harness !== undefined && api === undefined)
    judging.judgeHarness = harness;
  // Naming the harness under test is the default, not a change.
  const underTest =
    results.harnesses.length === 1 ? results.harnesses[0] : undefined;
  const sameWay =
    (api !== undefined ? "api" : "harness") === recorded.via &&
    (api !== undefined ||
      (harness ?? underTest ?? null) ===
        (recorded.harness ?? underTest ?? null));
  const named =
    options.judgeModel ?? (sameWay ? (recorded.model ?? undefined) : undefined);
  if (named !== undefined) judging.judgeModel = named;
  if (
    cases.some((one) => one.checks.some(isJudged)) &&
    (!sameWay ||
      (options.judgeModel !== undefined &&
        options.judgeModel !== recorded.model))
  ) {
    console.error(
      "skill-evals: warning: the judge differs from the one the earlier command used, so its cached answers may not apply",
    );
  }
  const { judgeApi, judgeModel } = judgeSetup(cases, judging);
  const deciding: Config = { ...config };
  const decided = decisionModelOf(source, options);
  if (decided !== undefined) deciding.decisionModel = decided;
  return {
    judgeApi,
    judgeModel,
    judgeHarness: judgeHarnessOf(judging),
    decision: decisionFor(cases, deciding),
  };
}

/**
 * Checks that a judged check that a harness session will answer has a harness to start.
 * @param source - The earlier command's results, which name each run's harness.
 * @param plan - What to do with each run.
 * @param judging - Who judges.
 * @throws {UsageError} When a re-scored case has a judged check, no judge API or judge harness is set, and the harness
 *   of the run is not installed.
 */
function requireJudge(source: Source, plan: Plan, judging: Judging): void {
  if (judging.judgeApi !== null || judging.judgeHarness !== undefined) return;
  for (const [index, record] of source.results.records.entries()) {
    const verdict = plan.verdicts[index];
    if (verdict?.kind !== "rescore") continue;
    if (!verdict.caseDef.checks.some(isJudged)) continue;
    const harness = harnessOf(record.harness);
    if (findBin(harness) === null) {
      throw new UsageError(
        `a judged check needs the harness ${harness.id}, which is not installed; pass --judge-harness or --judge-api`,
      );
    }
  }
}

/**
 * Settles whether skill checks keep the 0.0.1 rule.
 * @param source - The earlier command's results, which record whether it ran with `--lenient`.
 * @param options - The options after the config file was applied.
 * @returns `--lenient` when given, else what the earlier command used.
 */
const lenientOf = (source: Source, options: Merged): boolean =>
  options.lenient ?? source.results.meta.lenient ?? false;

/**
 * Scores one stored run again.
 * @param run - The run, its case now, and the judge cache slot of the run.
 * @param run.record - The stored run.
 * @param run.caseDef - The case as it is now.
 * @param run.cache - The judge cache, limited to the run's slot.
 * @param how - How the command judges, and where the files are.
 * @param how.judging - Who judges.
 * @param how.source - The earlier command's directory and results.
 * @param how.options - The options after the config file was applied.
 * @returns The new record.
 * @throws {UsageError} When the run's files are not usable.
 */
function rescoreOne(
  run: { record: RunRecord; caseDef: Case; cache: Cache },
  how: { judging: Judging; source: Source; options: Merged },
): Promise<RunRecord> {
  const { judging } = how;
  const harness = harnessOf(run.record.harness);
  const bin = findBin(harness) ?? "";
  const judge: Judge = {
    ...(judging.judgeHarness ?? { harness, bin }),
    model: judging.judgeModel,
  };
  return rescore(run.record, run.caseDef, {
    outDir: how.source.dir,
    lenient: lenientOf(how.source, how.options),
    scoring: {
      harness,
      judge,
      judgeApi: judging.judgeApi ?? undefined,
      decision: judging.decision,
      decisionModel: decisionModelOf(how.source, how.options),
      isolated: how.source.results.meta.isolated,
      pass: how.options.env,
      cache: run.cache,
    },
  });
}

/**
 * Scores one run again, and keeps it as it was when its files are not usable.
 * @param run - The run, its case now, and its judge cache slot.
 * @param run.record - The stored run.
 * @param run.caseDef - The case as it is now.
 * @param run.cache - The judge cache, limited to the run's slot.
 * @param how - How the command judges, and where the files are.
 * @param how.judging - Who judges.
 * @param how.source - The earlier command's directory and results.
 * @param how.options - The options after the config file was applied.
 * @returns The record to keep and what was not re-scored in it.
 */
async function rescoreKept(
  run: { record: RunRecord; caseDef: Case; cache: Cache },
  how: { judging: Judging; source: Source; options: Merged },
): Promise<{ record: RunRecord; notes: string[] }> {
  const name = runName(run.record);
  const omitted = run.record.workspaceArchive?.omitted?.length ?? 0;
  if (omitted > 0) {
    console.error(
      `skill-evals: warning: ${name}: the archive omitted ${String(omitted)} files matching login contents`,
    );
  }
  try {
    const again = await rescoreOne(run, how);
    console.error(`${name}: score ${formatScore(again.score)} (re-scored)`);
    const unscored = again.checks.filter(
      (check) => check.reason === NO_ARCHIVE,
    );
    return {
      record: again,
      notes: unscored.map(
        (check) => `${name}: ${describeCheck(check)}: ${NO_ARCHIVE}`,
      ),
    };
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return {
      record: run.record,
      notes: [`${name}: not re-scored: ${messageOf(error)}`],
    };
  }
}

/**
 * Re-scores every run that the plan says to re-score, one after the other. No harness of the agent is started; a judge
 * harness starts only for a judged check whose answer the cache does not hold.
 * @param source - The earlier command's directory and results.
 * @param plan - What to do with each run.
 * @param options - The options after the config file was applied.
 * @returns The records, who judged, and what was not re-scored.
 * @throws {UsageError} When a judged check needs a judge harness that is not installed, or the judge API or the decision
 *   model is not set up.
 */
export async function rescoreAll(
  source: Source,
  plan: Plan,
  options: Merged,
): Promise<Rescored> {
  const cases = [...plan.live.values()];
  const judging = judgingOf(source, cases, options);
  requireJudge(source, plan, judging);
  const cache = openCache(source.dir, true);
  const records: RunRecord[] = [];
  const notes: string[] = [];
  const keyless = new Set<string>();
  for (const [index, record] of source.results.records.entries()) {
    const verdict = plan.verdicts[index];
    if (verdict?.kind !== "rescore") {
      records.push(record);
      if (verdict?.note) notes.push(`${runName(record)}: ${verdict.note}`);
      continue;
    }
    const key = source.keys.get(stemOf(record)) ?? "";
    if (key === "" && keyless.size === 0) {
      keyless.add(record.caseId);
      console.error(
        "skill-evals: warning: a run has no key in results.jsonl, so its judge answers are cached apart from the earlier command's",
      );
    }
    const slot = scopedCache(cache, slotName(key, record.subject));
    const done = await rescoreKept(
      { record, caseDef: verdict.caseDef, cache: slot },
      { judging, source, options },
    );
    records.push(done.record);
    notes.push(...done.notes);
  }
  const { judgeApi, judgeHarness, judgeModel } = judging;
  const asked = cases.some((one) => one.checks.some(isJudged));
  const earlier = recordedJudge(source.results);
  return {
    records,
    notes,
    lenient: lenientOf(source, options),
    judge: asked
      ? {
          label: judgeText({ judgeApi, judgeHarness, judgeModel }),
          model: judgeModel ?? null,
          via: judgeApi ? "api" : "harness",
          harness: judgeHarness?.harness.id ?? null,
        }
      : { label: source.results.judge, ...earlier },
  };
}
