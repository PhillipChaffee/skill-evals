import { commandContext } from "./command.js";
import type { Check } from "./checks/index.js";
import { describeCheck, isDecision, isJudged } from "./checks/index.js";
import type { Harness } from "./harnesses/shared.js";
import { sumTokens } from "./harnesses/shared.js";
import { skillEvents, skillsLoaded } from "./skill-events.js";
import type { SkillEvent } from "./skill-events.js";
import type { Spend } from "./gate.js";
import { spendOf } from "./gate.js";
import type { CheckResult, RunRecord } from "./run-plan.js";
import type { RetryKind } from "./retry.js";
import { retryKind } from "./retry.js";
import type { RunPlan, Usage } from "./run-plan.js";
import { withheld } from "./run-plan.js";
import { failedRecord } from "./run-failed.js";
import { limitFields } from "./run-limits.js";
import { messageOf } from "./scope.js";
import { weightedMean } from "./score.js";
import type { SessionResult } from "./session.js";
import { session } from "./session.js";
import { scoreChecks } from "./score-checks.js";
import { startupRecord } from "./startup.js";
import { allChanged } from "./snapshot.js";
import type { Copy } from "./run-copy.js";
import { copyOf, observe } from "./run-copy.js";
import { relativeToHome } from "./rules-install.js";
import { fileState } from "./run-files.js";
import { keptArchive, stageKept } from "./run-archive.js";
import { seenFields } from "./run-seen.js";
import { flattened } from "./case-checks.js";
import { slicesOf } from "./turn-outcome.js";
import { failedCalls } from "./transcript.js";
import { writeStreams } from "./run-streams.js";

export type { CheckResult, Judge, RunPlan, Usage } from "./run-plan.js";
export type { RunRecord } from "./run-plan.js";

/**
 * Reads the two switches that change how a run is made and scored.
 * @param options - Options that may set either.
 * @param options.isolated - Start the harness with nothing loaded but the subject.
 * @param options.lenient - Keep the 0.0.1 rule for skill loads.
 * @param options.useCache - Serve judge answers from the cache.
 * @returns `isolated`, `lenient` and `useCache`, each false when not set.
 */
export const modesOf = (options: {
  isolated?: boolean | undefined;
  lenient?: boolean | undefined;
  useCache?: boolean | undefined;
}): { isolated: boolean; lenient: boolean; useCache: boolean } => ({
  isolated: options.isolated ?? false,
  lenient: options.lenient ?? false,
  useCache: options.useCache ?? false,
});

/**
 * Names the kind of a check for the reason that it has no score.
 * @param check - A check without a score.
 * @returns "decision" or "judged" for a model's check, "command" for a command, else "file".
 */
function checkKind(check: Check): string {
  if (isDecision(check)) return "decision";
  if (isJudged(check)) return "judged";
  return check.type === "command" ? "command" : "file";
}

/**
 * Tells whether a run has no check left to score.
 * @param checks - The run's check results.
 * @returns The reason when there are checks and every one is on a reply turn that was not asked, naming those turns;
 *   null otherwise.
 */
function nothingScored(checks: CheckResult[]): string | null {
  if (checks.length === 0 || checks.some((check) => !check.notScored)) {
    return null;
  }
  const turns = checks.flatMap((check) => check.turn ?? []);
  if (turns.length < checks.length) {
    return `nothing was scored: ${String(checks[0]?.reason)}`;
  }
  const named = [...new Set(turns)].join(", ");
  return `nothing was scored: every check is on a reply turn that was not asked (turn ${named})`;
}

/**
 * Decides whether a run counts.
 * @param record - The parts of a run record that can disqualify it.
 * @returns Why the record must not be counted, or null when it is a valid run.
 */
export function invalidReason(
  record: Pick<
    RunRecord,
    | "error"
    | "subjectLoaded"
    | "isolated"
    | "reportMissing"
    | "unexpected"
    | "judgeProblem"
    | "checks"
    | "preconditions"
  >,
): string | null {
  if (record.error) return `run failed: ${record.error}`;
  if (record.subjectLoaded === false) {
    return "the harness did not load the subject: it is not among the plugins and skills it reported";
  }
  if (record.isolated && record.reportMissing) {
    return "the harness did not report what it loaded";
  }
  if (record.isolated && record.unexpected.length > 0) {
    return `loaded outside the subject: ${record.unexpected.join(", ")}`;
  }
  if (record.isolated && record.judgeProblem) return record.judgeProblem;
  const unmet = record.preconditions?.find((check) => !check.score);
  if (unmet) return `precondition not met: ${describeCheck(unmet)}`;
  const unscored = record.checks.find(
    (check) => check.score === null && check.notScored === undefined,
  );
  if (unscored) {
    return `a ${checkKind(unscored)} check has no score: ${String(unscored.reason)}`;
  }
  return nothingScored(record.checks);
}

/**
 * Adds up what the calls of a scoring model cost.
 * @param replies - Every reply of the judge, or every request to the decision model, for one run.
 * @returns The totals. A cost that any reply does not report stays null.
 */
function totalUsage(replies: Usage[]): Usage & { calls: number } {
  const costs = replies.flatMap((reply) => reply.costUsd ?? []);
  return {
    calls: replies.length,
    durationMs: replies.reduce((total, reply) => total + reply.durationMs, 0),
    tokens: sumTokens(replies.flatMap((reply) => reply.tokens ?? [])),
    costUsd:
      costs.length === replies.length
        ? costs.reduce((total, cost) => total + cost, 0)
        : null,
  };
}

/**
 * Sums what the judge cost for one run.
 * @param replies - Every reply of the judge.
 * @param hits - How many answers came from the cache.
 * @returns The totals, with `cacheHits` when there were any; null when the judge was never asked.
 */
const judgeUsage = (replies: Usage[], hits: number): RunRecord["judge"] =>
  replies.length || hits
    ? { ...totalUsage(replies), ...(hits ? { cacheHits: hits } : {}) }
    : null;

/**
 * Finds the skill events of a finished session.
 * @param harness - The adapter, which says what path a read call targets.
 * @param ran - What the session produced.
 * @param copy - The run's copy of the subject; null for "none".
 * @returns The events of the run's tool calls, against the copy and the skill copies the adapter placed.
 */
const skillEventsOf = (
  harness: Harness,
  ran: SessionResult,
  copy: Copy | null,
): SkillEvent[] =>
  skillEvents(
    ran.parsed.toolCalls,
    {
      skillDirs: copy?.loaded.skillDirs ?? {},
      placed: ran.placed,
      pluginName: copy?.loaded.pluginName,
    },
    {
      failed: failedCalls(ran.parsed.transcript),
      home: ran.home,
      workspace: ran.workspace,
      pathOf: harness.pathOf,
      skillOf: harness.skillOf,
    },
  );

/**
 * Makes the plan that this run's own judges see: the gate does not have the run's agent cost yet, but the judges must
 * not push the budget over it.
 * @param plan - The run.
 * @param agentCost - What the agent cost; null when the harness stated none.
 * @returns The plan, with `breached` counting the agent's cost as spent.
 */
function guardedBy(plan: RunPlan, agentCost: number | null): RunPlan {
  const { breached } = plan;
  return breached
    ? { ...plan, breached: () => breached(agentCost ?? 0) }
    : plan;
}

/**
 * Puts the scored checks into the run's record, and adds up what the attempt cost.
 * @param base - What the record says before its checks.
 * @param scored - What `scoreChecks` returned.
 * @param agentCost - What the agent cost; null when the harness stated none.
 * @returns The record, with a score unless the run is invalid, and the spend.
 */
export function assemble(
  base: Omit<
    RunRecord,
    "judgeProblem" | "checks" | "preconditions" | "score" | "judge" | "decision"
  >,
  scored: Awaited<ReturnType<typeof scoreChecks>>,
  agentCost: number | null,
): { record: RunRecord; spend: Spend } {
  const { checks, replies, requests, hits, skippedGraders } = scored;
  const { preconditions } = scored;
  const judged = {
    ...base,
    judgeProblem: scored.judgeProblem,
    checks,
    ...(preconditions.length > 0 ? { preconditions } : {}),
  };
  return {
    record: {
      ...judged,
      score: invalidReason(judged)
        ? null
        : weightedMean(checks.filter((check) => check.notScored === undefined)),
      judge: judgeUsage(replies, hits),
      decision: requests.length ? totalUsage(requests) : null,
      ...(skippedGraders ? { skippedGraders } : {}),
    },
    spend: spendOf(agentCost, [...replies, ...requests]),
  };
}

/**
 * Takes what the session did with the subject's rules.
 * @param ran - What the session produced.
 * @returns The record's `rules`; nothing when the subject names none.
 */
const rulesOf = (ran: SessionResult): Pick<RunRecord, "rules"> =>
  ran.rulesInstalled
    ? {
        rules: {
          installed: ran.rulesInstalled,
          reportedLoaded: relativeToHome(ran.home, ran.parsed.loaded.rules),
        },
      }
    : {};

/**
 * Takes what a session knows of the turns of its case.
 * @param ran - What the session produced.
 * @returns Each turn's record and workspace changes; null for a case with one prompt.
 */
const turnsOf = (
  ran: SessionResult,
): Required<Pick<RunRecord, "userTurns" | "turnChanges">> | null =>
  ran.userTurns && {
    userTurns: ran.userTurns,
    turnChanges: ran.turnChanges ?? [],
  };

/**
 * Turns a finished session into a run record: writes the run's files, then scores every check.
 * @param plan - The run that was made.
 * @param ran - What the session produced; its workspace still exists.
 * @param copy - The run's copy of the subject; null for "none".
 * @returns The record, with a score unless the run is invalid.
 */
async function record(
  plan: RunPlan,
  ran: SessionResult,
  copy: Copy | null,
): Promise<{ record: RunRecord; spend: Spend }> {
  const { harness, subject, caseDef, rep } = plan;
  const { parsed, error, durationMs } = ran;
  const { changes, observed } = observe(copy, ran);
  const events = skillEventsOf(harness, ran, copy);
  const transcript = writeStreams(plan, ran);
  const files = fileState(ran);
  const turned = turnsOf(ran);
  const base = {
    harness: harness.id,
    subject: subject.label,
    caseId: caseDef.id,
    rep,
    ok: !error,
    error,
    finalText: parsed.finalText,
    toolCalls: parsed.toolCalls,
    skillsLoaded: skillsLoaded(events),
    skillEvents: events,
    transcriptFile: transcript.relative,
    ...seenFields(plan),
    ...turned,
    ...rulesOf(ran),
    askedUser: parsed.askedUser ?? null,
    ...startupRecord(plan, ran, copy),
    ...limitFields(harness, caseDef, ran),
    subjectMutated: changes !== null && allChanged(changes).length > 0,
    subjectChanges: changes,
    changedFiles: files.changed,
    durationMs,
    tokens: parsed.tokens,
    agentTokens: parsed.agentTokens ?? null,
    costUsd: parsed.costUsd,
  };
  const staged = stageKept(plan, ran);
  const scored = await scoreChecks(
    { ...guardedBy(plan, parsed.costUsd), caseDef: flattened(caseDef) },
    {
      ...parsed,
      ...(turned && { turns: slicesOf({ parsed, events, ...turned }) }),
      skillEvents: events,
      legacySkillLoads: plan.lenient ?? false,
      ...files,
      command: commandContext(ran, caseDef.env, transcript.files),
      subject: {
        dir: copy?.loaded.dir ?? null,
        mutated: changes ? allChanged(changes) : [],
        observed,
      },
    },
    invalidReason({ ...base, judgeProblem: null, checks: [] }) === null,
  );
  const kept = keptArchive(plan, staged, transcript.stem);
  const archived = kept === null ? {} : { workspaceArchive: kept };
  return assemble({ ...base, ...archived }, scored, parsed.costUsd);
}

/** One attempt at a run: its record, and whether the failure that it shows is worth another attempt. */
export interface Attempted {
  record: RunRecord;
  /** Why the run may be tried again; null for a run that passed, failed for the agent's reasons, or never got going. */
  retry: RetryKind | null;
  /** What the attempt cost, reply by reply. */
  spend: Spend;
}

/**
 * Makes one attempt at a run: one prompt, one harness, one subject. It runs the prompt, normalizes the output, scores
 * every check, and cleans up.
 * @param plan - What to run and where to write its files.
 * @returns The record of the attempt, and whether to try again. A failed run is a record with an error, never a
 *   rejection.
 */
export async function runAttempt(plan: RunPlan): Promise<Attempted> {
  const { harness, bin, subject, caseDef } = plan;
  const { prompt, turns, maxTurns, timeoutSeconds } = caseDef;
  const copy = copyOf(subject);
  try {
    return await session(
      {
        harness,
        bin,
        // To a harness, no skills and the judge's "nothing loaded" are the same thing.
        subject: copy?.loaded ?? null,
        prompt,
        turns,
        totalTimeoutSeconds: caseDef.totalTimeoutSeconds,
        model: caseDef.model ?? plan.model,
        env: caseDef.env,
        maxTurns,
        onTimeout: caseDef.onTimeout,
        isolated: plan.isolated,
        rules: copy?.rules ?? null,
        historyMode: plan.historyMode,
        timeoutSeconds,
        layers: caseDef,
        withhold: withheld(plan),
        pass: plan.pass,
        keepSeed: plan.keepWorkspaces,
      },
      async (ran) => {
        const made = await record(plan, ran, copy);
        return {
          ...made,
          retry: retryKind(harness, ran.ending, made.record),
        };
      },
    );
  } catch (error) {
    // Anything unexpected while the run was made or scored is this run's problem, never the suite's.
    // A run that broke while it was scored may have been paid for; nothing says how much.
    const spend = { costUsd: 0, reported: false, unreported: 1 };
    return { record: failedRecord(plan, messageOf(error)), retry: null, spend };
  } finally {
    copy?.dispose();
  }
}

/**
 * Makes one run once: one prompt, one harness, one subject.
 * @param plan - What to run and where to write its files.
 * @returns The record of the run. A failed run is a record with an error, never a rejection.
 */
export async function runOnce(plan: RunPlan): Promise<RunRecord> {
  return (await runAttempt(plan)).record;
}
