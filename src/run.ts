import fs from "node:fs";
import path from "node:path";
import { commandContext } from "./command.js";
import { isDecision, isJudged } from "./checks/index.js";
import type { Harness, Loaded, Tokens, ToolCall } from "./harnesses/shared.js";
import { sumTokens } from "./harnesses/shared.js";
import { skillEvents, skillsLoaded } from "./skill-events.js";
import type { SkillEvent } from "./skill-events.js";
import type { CheckResult, RunPlan, Usage } from "./run-plan.js";
import { withheld } from "./run-plan.js";
import { failedRecord } from "./run-failed.js";
import { messageOf } from "./scope.js";
import { weightedMean } from "./score.js";
import type { SessionResult } from "./session.js";
import { session } from "./session.js";
import { scoreChecks } from "./score-checks.js";
import { startupRecord } from "./startup.js";
import type { ChangedFiles } from "./snapshot.js";
import { allChanged } from "./snapshot.js";
import type { Copy } from "./run-copy.js";
import { copyOf, observe } from "./run-copy.js";
import { fileState } from "./run-files.js";
import { failedCalls, writeTranscript } from "./transcript.js";

export type { CheckResult, Judge, RunPlan, Usage } from "./run-plan.js";

/** Everything kept about one run. */
export interface RunRecord extends Usage {
  harness: string;
  /** The subject's label. */
  subject: string;
  caseId: string;
  rep: number;
  ok: boolean;
  error: string | null;
  finalText: string;
  toolCalls: ToolCall[];
  /** The run's tokens by agent id (`main`, or the id of the dispatch call), summed from the usage of each assistant message; null where the stream does not state usage per message. `tokens` is unchanged. Absent from earlier records. */
  agentTokens?: Record<string, Tokens> | null;
  skillsLoaded: string[];
  /** Every call that gave the agent a skill or a file of one, with how and where. `skillsLoaded` is the names of its loads. */
  skillEvents: SkillEvent[];
  /** The run's whole transcript, relative to the output directory; null when none was written. Absent from 0.0.1 records. */
  transcriptFile?: string | null;
  /** Whether the harness reported the subject as loaded at startup; null when it reports nothing, or when there is nothing to load. */
  subjectLoaded: boolean | null;
  /** What the harness reported as loaded at startup; a kind it does not report is null. */
  loaded: Loaded;
  /** Whether the run was started with `--isolated`. */
  isolated: boolean;
  /** The names of what the harness reported that does not come from the subject, whether or not `isolated` is set. */
  unexpected: string[];
  /** True when the harness should report its plugins and skills (`loadedReport`) and left one out. */
  reportMissing: boolean;
  /** Why the judge session, which loads nothing, does not prove it loaded nothing; null when it does, or when no isolated judge ran. */
  judgeProblem: string | null;
  /** Whether the run changed anything in its copy of the subject. Always false for "none". */
  subjectMutated: boolean;
  /** What the run created, modified and deleted in its copy of the subject; null for "none". */
  subjectChanges: ChangedFiles | null;
  /** What the run created, modified and deleted in its workspace, compared with the seed taken before the harness started. */
  changedFiles: ChangedFiles;
  checks: CheckResult[];
  /** The run score, null when the run is invalid. */
  score: number | null;
  /** What the judged checks cost, kept apart from the run's own numbers; null when no judge ran. */
  judge: (Usage & { calls: number; cacheHits?: number }) | null;
  /** What the decision checks cost, kept apart in the same way; null when no request was sent. */
  decision: (Usage & { calls: number }) | null;
}

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
  const unscored = record.checks.find((check) => check.score === null);
  if (unscored) {
    const kind = isDecision(unscored)
      ? "decision"
      : isJudged(unscored)
        ? "judged"
        : "command";
    return `a ${kind} check has no score: ${String(unscored.reason)}`;
  }
  return null;
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
 * Writes the run's stream, final text and transcript under the output directory.
 * @param plan - The run that was made.
 * @param ran - What the session produced.
 * @returns The transcript file: its absolute path, and its path relative to the output directory.
 */
function writeStreams(
  plan: RunPlan,
  ran: SessionResult,
): { absolute: string; relative: string } {
  const { harness, subject, caseDef, rep } = plan;
  const stem = path.join(
    plan.outDir,
    harness.id,
    caseDef.id,
    `${subject.label}${String(rep)}`,
  );
  fs.mkdirSync(path.dirname(stem), { recursive: true });
  fs.writeFileSync(`${stem}.stream.jsonl`, ran.stdout);
  fs.writeFileSync(`${stem}.final.md`, ran.parsed.finalText);
  const absolute = path.resolve(writeTranscript(stem, ran.parsed.transcript));
  return {
    absolute,
    relative: path.relative(path.resolve(plan.outDir), absolute),
  };
}

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
): Promise<RunRecord> {
  const { harness, subject, caseDef, rep } = plan;
  const { parsed, error, durationMs } = ran;
  const { changes, observed } = observe(copy, ran);
  const events = skillEventsOf(harness, ran, copy);
  const loaded = skillsLoaded(events);

  const transcript = writeStreams(plan, ran);
  const files = fileState(ran);
  const base = {
    harness: harness.id,
    subject: subject.label,
    caseId: caseDef.id,
    rep,
    ok: !error,
    error,
    finalText: parsed.finalText,
    toolCalls: parsed.toolCalls,
    skillsLoaded: loaded,
    skillEvents: events,
    transcriptFile: transcript.relative,
    ...startupRecord(plan, ran, copy),
    subjectMutated: changes !== null && allChanged(changes).length > 0,
    subjectChanges: changes,
    changedFiles: files.changed,
    durationMs,
    tokens: parsed.tokens,
    agentTokens: parsed.agentTokens ?? null,
    costUsd: parsed.costUsd,
  };
  const { checks, replies, requests, judgeProblem, hits } = await scoreChecks(
    plan,
    {
      ...parsed,
      skillEvents: events,
      legacySkillLoads: plan.lenient ?? false,
      ...files,
      command: commandContext(ran, caseDef.env, transcript.absolute),
      subject: {
        dir: copy?.loaded.dir ?? null,
        mutated: changes ? allChanged(changes) : [],
        observed,
      },
    },
    invalidReason({ ...base, judgeProblem: null, checks: [] }) === null,
  );
  const judged = { ...base, judgeProblem, checks };
  return {
    ...judged,
    score: invalidReason(judged) ? null : weightedMean(checks),
    judge:
      replies.length || hits
        ? { ...totalUsage(replies), ...(hits ? { cacheHits: hits } : {}) }
        : null,
    decision: requests.length ? totalUsage(requests) : null,
  };
}

/**
 * Makes one run: one prompt, one harness, one subject. It runs the prompt, normalizes the output, scores every
 * check, and cleans up.
 * @param plan - What to run and where to write its files.
 * @returns The record of the run. A failed run is a record with an error, never a rejection.
 */
export async function runOnce(plan: RunPlan): Promise<RunRecord> {
  const { harness, bin, subject, caseDef } = plan;
  const { prompt, maxTurns, timeoutSeconds } = caseDef;
  const copy = copyOf(subject);
  try {
    return await session(
      {
        harness,
        bin,
        // To a harness, no skills and the judge's "nothing loaded" are the same thing.
        subject: copy?.loaded ?? null,
        prompt,
        model: caseDef.model ?? plan.model,
        env: caseDef.env,
        maxTurns,
        isolated: plan.isolated,
        timeoutSeconds,
        layers: caseDef,
        withhold: withheld(plan),
        pass: plan.pass,
      },
      (ran) => record(plan, ran, copy),
    );
  } catch (error) {
    // Anything unexpected while the run was made or scored is this run's problem, never the suite's.
    return failedRecord(plan, messageOf(error));
  } finally {
    copy?.dispose();
  }
}
