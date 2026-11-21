import fs from "node:fs";
import path from "node:path";
import type { Case } from "./cases.js";
import type { Check, Outcome } from "./checks/index.js";
import { checkScore, isDecision, isJudged } from "./checks/index.js";
import type { DecisionService } from "./decision.js";
import { decide } from "./decision.js";
import type {
  Harness,
  LoadedSubject,
  Parsed,
  Tokens,
  ToolCall,
} from "./harnesses/shared.js";
import { sumTokens } from "./harnesses/shared.js";
import { judge } from "./judge.js";
import { weightedMean } from "./score.js";
import type { SessionResult } from "./session.js";
import { session } from "./session.js";
import type { ChangedFiles } from "./snapshot.js";
import { allChanged } from "./snapshot.js";
import type { Copy } from "./run-copy.js";
import { copyOf, observe } from "./run-copy.js";
import type { Subject } from "./subject.js";

/** What a session cost. A number the harness does not report is null. */
export interface Usage {
  durationMs: number;
  tokens: Tokens | null;
  costUsd: number | null;
}

/** A check with what it gave one run. */
export type CheckResult = Check & {
  /** Null when a judged check or a decision check got no usable answer. */
  score: number | null;
  /** The judge's reason, or why there is no score. */
  reason?: string;
  /** For a decision check, the probability the model gave each allowed answer. */
  probabilities?: Record<string, number>;
};

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
  skillsLoaded: string[];
  /** Whether the harness reported the subject as loaded at startup; null when it reports nothing, or when there is nothing to load. */
  subjectLoaded: boolean | null;
  /** Whether the run changed anything in its copy of the subject. Always false for "none". */
  subjectMutated: boolean;
  /** What the run created, modified and deleted in its copy of the subject; null for "none". */
  subjectChanges: ChangedFiles | null;
  checks: CheckResult[];
  /** The run score, null when the run is invalid. */
  score: number | null;
  /** What the judged checks cost, kept apart from the run's own numbers; null when no judge ran. */
  judge: (Usage & { calls: number }) | null;
  /** What the decision checks cost, kept apart in the same way; null when no request was sent. */
  decision: (Usage & { calls: number }) | null;
}

/** The harness and model that score judged checks. */
export interface Judge {
  harness: Harness;
  bin: string;
  model?: string | undefined;
}

/** One run to make: one case, one harness, one subject. */
export interface RunPlan {
  harness: Harness;
  bin: string;
  subject: Subject;
  caseDef: Case;
  rep: number;
  model?: string | undefined;
  judge: Judge;
  /** Names of variables the harness gets besides the allowlist: the config's `env`. */
  pass?: string[] | undefined;
  /** The model that scores decision checks; null when no case has one. */
  decision: DecisionService | null;
  /** Where the run's stream and final text are written. */
  outDir: string;
}

// A judge answers in one message. The second turn is room for one stray tool call before the answer.
const JUDGE_LIMITS = { maxTurns: 2, timeoutSeconds: 300 };
// A decision check that no request was sent for: only a valid run is decided, and a suite with decision checks
// does not start without a decision model.
const NOT_DECIDED = {
  score: null,
  reason: "not decided, because the run is invalid",
};
// The key of the decision model stays out of every harness process, the agent's and the judge's.
const withheld = (plan: RunPlan): string[] =>
  plan.decision ? [plan.decision.secret] : [];
const SKILL_FILE = /skills[\\/]+([\w-]+)[\\/]+skill\.md/gi;

/**
 * Applies the one rule for "the agent loaded a skill", shared by every harness.
 * @param toolCalls - Every tool call of a run.
 * @returns The sorted names of the skills the agent loaded: through a call of the harness's skill tool that names it
 *   (any `plugin:` prefix dropped), or through any tool call whose input points at `skills/<name>/SKILL.md`.
 */
export function skillsLoaded(toolCalls: ToolCall[]): string[] {
  const names = new Set<string>();
  for (const { kind, input } of toolCalls) {
    if (kind === "skill") {
      // Object() turns an input that is no object into one with none of the three keys.
      const given = Object(input) as Record<string, unknown>;
      const named = [given["skill"], given["name"], given["id"]].find(
        (value) => typeof value === "string",
      );
      if (named) names.add(named.slice(named.lastIndexOf(":") + 1));
    }
    for (const match of JSON.stringify(input ?? null).matchAll(SKILL_FILE)) {
      names.add(String(match[1]));
    }
  }
  return [...names].sort();
}

/**
 * Decides whether a run counts.
 * @param record - The parts of a run record that can disqualify it.
 * @returns Why the record must not be counted, or null when it is a valid run.
 */
export function invalidReason(
  record: Pick<RunRecord, "error" | "subjectLoaded" | "checks">,
): string | null {
  if (record.error) return `run failed: ${record.error}`;
  if (record.subjectLoaded === false) {
    return "the harness did not load the subject: it is not among the plugins and skills it reported";
  }
  const unscored = record.checks.find((check) => check.score === null);
  if (unscored) {
    const kind = isDecision(unscored) ? "decision" : "judged";
    return `a ${kind} check has no score: ${String(unscored.reason)}`;
  }
  return null;
}

/**
 * Compares two paths that may reach one directory through different symlinks.
 * @param x - A path, which need not exist.
 * @param y - Another path.
 * @returns True when both resolve to the same real path.
 */
function samePath(x: string, y: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(x) === real(y);
}

type Loaded = Parsed["loaded"];
// Subject kind -> whether the harness reported the subject as loaded, or null when it does not report that.
// A plugin is found by its directory and a skills folder by the name of every skill in it.
const REPORTED_LOADED = {
  plugin: (subject: LoadedSubject, { paths }: Loaded) =>
    paths && paths.some((loadedPath) => samePath(loadedPath, subject.dir)),
  skills: (subject: LoadedSubject, { skills }: Loaded) =>
    skills && subject.skills.every((name) => skills.includes(name)),
};

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
 * Scores every check of a case for one run.
 * @param plan - The run; its judge scores the judged checks, with nothing loaded and a prompt that carries nothing
 *   about the subject.
 * @param outcome - What the deterministic checks observe.
 * @param judgeable - False when the run is already invalid, which leaves the judged checks without a score.
 * @returns The check results in case order, every reply of the judge, and every request to the decision model.
 */
async function scoreChecks(
  plan: RunPlan,
  outcome: Outcome,
  judgeable: boolean,
): Promise<{ checks: CheckResult[]; replies: Usage[]; requests: Usage[] }> {
  const { prompt: task, checks: asked } = plan.caseDef;
  const withhold = withheld(plan);
  const ask = (judgePrompt: string) =>
    session(
      {
        ...plan.judge,
        subject: null,
        prompt: judgePrompt,
        ...JUDGE_LIMITS,
        withhold,
        pass: plan.pass,
      },
      ({ parsed, error, durationMs }) => ({
        finalText: parsed.finalText,
        error,
        durationMs,
        tokens: parsed.tokens,
        costUsd: parsed.costUsd,
      }),
    );
  // One request carries every decision check of the case.
  const decisions = asked.filter(isDecision);
  const decided =
    judgeable && plan.decision && decisions.length
      ? await decide(plan.decision.model, {
          task,
          answer: outcome.finalText,
          checks: decisions,
        })
      : null;
  const checks: CheckResult[] = [];
  const replies: Usage[] = [];
  for (const check of asked) {
    if (isDecision(check)) {
      const result = decided?.results[decisions.indexOf(check)];
      checks.push({ ...check, ...(result ?? NOT_DECIDED) });
    } else if (!isJudged(check)) {
      checks.push({ ...check, ...checkScore(check, outcome) });
    } else if (!judgeable) {
      const reason = "not judged, because the run is invalid";
      checks.push({ ...check, score: null, reason });
    } else {
      const verdict = await judge(ask, {
        task,
        answer: outcome.finalText,
        rubric: check.rubric,
      });
      replies.push(...verdict.replies);
      checks.push({ ...check, score: verdict.score, reason: verdict.reason });
    }
  }
  return { checks, replies, requests: decided?.calls ?? [] };
}

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
  const { stdout, parsed, error, durationMs } = ran;
  const { changes, observed } = observe(copy, ran);
  const loaded = skillsLoaded(parsed.toolCalls);

  const stem = path.join(
    plan.outDir,
    harness.id,
    caseDef.id,
    `${subject.label}${String(rep)}`,
  );
  fs.mkdirSync(path.dirname(stem), { recursive: true });
  fs.writeFileSync(`${stem}.stream.jsonl`, stdout);
  fs.writeFileSync(`${stem}.final.md`, parsed.finalText);

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
    subjectLoaded: copy
      ? REPORTED_LOADED[copy.loaded.kind](copy.loaded, parsed.loaded)
      : null,
    subjectMutated: changes !== null && allChanged(changes).length > 0,
    subjectChanges: changes,
    durationMs,
    tokens: parsed.tokens,
    costUsd: parsed.costUsd,
  };
  const { checks, replies, requests } = await scoreChecks(
    plan,
    {
      ...parsed,
      skillsLoaded: loaded,
      workspace: ran.workspace,
      subject: {
        dir: copy?.loaded.dir ?? null,
        mutated: changes ? allChanged(changes) : [],
        observed,
      },
    },
    invalidReason({ ...base, checks: [] }) === null,
  );
  return {
    ...base,
    checks,
    score: invalidReason({ ...base, checks }) ? null : weightedMean(checks),
    judge: replies.length ? totalUsage(replies) : null,
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
  const { harness, bin, subject, caseDef, model } = plan;
  const { prompt, maxTurns, timeoutSeconds, workspaceDir } = caseDef;
  const copy = copyOf(subject);
  try {
    return await session(
      {
        harness,
        bin,
        // To a harness, no skills and the judge's "nothing loaded" are the same thing.
        subject: copy?.loaded ?? null,
        prompt,
        model,
        maxTurns,
        timeoutSeconds,
        workspaceDir,
        withhold: withheld(plan),
        pass: plan.pass,
      },
      (ran) => record(plan, ran, copy),
    );
  } finally {
    copy?.dispose();
  }
}
