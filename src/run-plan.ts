import type { Case } from "./cases.js";
import type { Check, Verdict } from "./checks/index.js";
import type { Cache } from "./cache.js";
import type { DecisionService } from "./decision.js";
import type { StopReason } from "./gate.js";
import type { Harness, Tokens } from "./harnesses/shared.js";
import type { HistoryMode } from "./history-types.js";
import type { JudgeApi } from "./judge-api.js";
import type { SandboxCapability } from "./os-sandbox.js";
import type { ToolCall, Loaded } from "./harnesses/shared.js";
import type { SkillEvent } from "./skill-events.js";
import type { LimitFields } from "./run-limits.js";
import type { WorkspaceArchive } from "./run-archive.js";
import type { ChangedFiles } from "./snapshot.js";
import type { TurnRecord } from "./turn-outcome.js";
import type { Subject } from "./subject.js";

/** What a session cost. A number the harness does not report is null. */
export interface Usage {
  durationMs: number;
  tokens: Tokens | null;
  costUsd: number | null;
}

/** A check with what it gave one run. */
export type CheckResult = Check & {
  /** Null when a judged check, a decision check or a command check got no usable answer. */
  score: number | null;
  /** The judge's reason, or why there is no score. */
  reason?: string;
  /** For a judge check with `votes` above 1: what each vote gave. A vote with no usable answer has a null score. */
  ballots?: { score: number | null; reason: string }[];
  /** For a decision check, the probability the model gave each allowed answer. */
  probabilities?: Record<string, number>;
  /** For a command check: what the command did, each stream cut to its last 2,000 bytes. */
  command?: Verdict["command"];
  /**
   * True for a check of a conditional reply turn that was not sent because the agent did not ask: its score is null,
   * and the run's score and validity leave it out. Absent otherwise.
   */
  notScored?: true;
};

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
  /** Start the harness with nothing loaded but the subject, and invalidate a run that reports anything else. */
  isolated?: boolean | undefined;
  /** `--history-mode`: how a case's history reaches the agent. Absent: the harness's own mode. */
  historyMode?: HistoryMode | undefined;
  /** Keep the 0.0.1 rule for `skill_loaded` and `skill_not_loaded` (`--lenient`). */
  lenient?: boolean | undefined;
  /** Names of variables the harness gets besides the allowlist: the config's `env`. */
  pass?: string[] | undefined;
  /** The model that scores decision checks; null when no case has one. */
  decision: DecisionService | null;
  /** The id of the decision model, which a reused result must share; absent when none is set. */
  decisionModel?: string | undefined;
  /** The base URL of the decision model's API, which a reused result must share; absent when none is set. */
  decisionUrl?: string | undefined;
  /** Where the run's stream and final text are written. */
  outDir: string;
  /** Archive the run's workspace, seed, remotes and home, less the login files, as `<stem>.workspace.tar` (`--keep-workspaces`). */
  keepWorkspaces?: boolean | undefined;
  /** Set, the judge asks the API and starts no harness process; `judge` is then not used. */
  judgeApi?: JudgeApi | undefined;
  /** Set under `--sandbox`: the harness process runs in the sandbox, with the case's `network`. */
  sandbox?: SandboxCapability | undefined;
  /** The project root, which `no_writes_outside_workspace` watches before and after the run. */
  projectRoot?: string | undefined;
  /** What the judge answered before, in this output directory; none for no cache. */
  cache?: Cache | undefined;
  /**
   * Tells whether a cost or time limit of the command is reached now, counting the agent's cost of this run, which the
   * gate does not have yet, as `pendingUsd`. When it is, the run's judged and decision checks are not asked: they get no
   * score, the run is invalid and carries `skippedGraders`. Absent: never.
   */
  breached?: ((pendingUsd: number) => StopReason | null) | undefined;
}

/** The part of a run's plan that scoring its checks reads. */
export type ScoringPlan = Pick<
  RunPlan,
  | "harness"
  | "caseDef"
  | "judge"
  | "judgeApi"
  | "decision"
  | "decisionModel"
  | "isolated"
  | "pass"
  | "cache"
  | "breached"
>;

/**
 * Names what no harness process of a run may get.
 * @param plan - The run.
 * @returns The decision model's key, when there is a decision model, and the judge API's key, unless it is one of this
 *   harness's own login variables: then the agent already has it.
 */
export const withheld = (
  plan: Pick<RunPlan, "decision" | "judgeApi" | "harness">,
): string[] => [
  ...(plan.decision ? [plan.decision.secret] : []),
  ...(plan.judgeApi && !plan.harness.authEnv.includes(plan.judgeApi.keyVar)
    ? [plan.judgeApi.keyVar]
    : []),
];

/** Everything kept about one run. */
export interface RunRecord extends Usage, LimitFields {
  harness: string;
  /** The subject's label. */
  subject: string;
  /** The options of the subject's spec, such as `hooks=off`, in one text, so that a resume never takes a record of another variant. Absent for a subject without options. */
  options?: string;
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
  /** The sha256 of what the agent saw: the prompt, files, setup, harness, model, `maxTurns` and env names; not the checks. Absent from earlier records. */
  inputHash?: string;
  /** What the harness reported of stopping for the user's answer (`Parsed.askedUser`), for `ended_awaiting_user` at case level; null when it reports nothing. Absent from a record made before the question kind, which `rescore` does not score `asked_user` and `ended_awaiting_user` from. */
  askedUser?: boolean | null;
  /** Each turn of a case with `turns`, in order, with what it said and whether it was sent. Absent for a single prompt. */
  userTurns?: TurnRecord[];
  /** What each turn created, modified and deleted in the workspace, from a hash taken after it (no files are copied); the order of `userTurns`. Absent for a single prompt. */
  turnChanges?: ChangedFiles[];
  /** The archive of the run's workspace, seed, remotes and home (`--keep-workspaces`); null when none was kept. Absent from earlier records. */
  workspaceArchive?: WorkspaceArchive | null;
  /** Whether the harness reported the subject as loaded at startup; null when it reports nothing, or when there is nothing to load. */
  subjectLoaded: boolean | null;
  /** What the harness reported as loaded at startup; a kind it does not report is null. */
  loaded: Loaded;
  /** Whether the run was started with `--isolated`. */
  isolated: boolean;
  /**
   * How the case's `history.json` reached the agent: "native" or "preamble"; null for a case with no history. Absent from
   * earlier records.
   */
  historyMode?: HistoryMode | null;
  /** Agents and skills that the subject's options removed and the harness reported as loaded anyway; the run is invalid. Absent when there are none. */
  strippedLoaded?: string[];
  /** The names of what the harness reported that does not come from the subject, whether or not `isolated` is set. */
  unexpected: string[];
  /** Why the run's mock MCP servers cannot be trusted: a server that did not connect or was not reported, an MCP server that is neither a mock nor the subject's, a mock log that disagrees with the stream. The run is invalid. Absent when there is nothing wrong. */
  mcpProblems?: string[];
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
  /**
   * What changed in the canaries (the operator's home dotfiles and the project root) while the harness ran, each path with
   * how it differs, for a case with a `no_writes_outside_workspace` check. Absent for a case without one.
   */
  canaryChanges?: string[];
  checks: CheckResult[];
  /**
   * The case's `preconditions` with their scores. A precondition that scores 0 makes the run invalid; none counts in
   * the run's score. Absent for a case with none.
   */
  preconditions?: CheckResult[];
  /**
   * What the run did with the subject's rules (`rules`, `instructionFile`): `installed` is where the adapter put each
   * file, as `home/<path>` or `workspace/<path>`, and empty for a harness that installs none; `reportedLoaded` is what
   * the harness says it loaded, relative to the run's home, null when it reports no rule. Absent when the subject names no rules.
   */
  rules?: { installed: string[]; reportedLoaded: string[] | null };
  /** The run score, null when the run is invalid. */
  score: number | null;
  /** What the judged checks cost, kept apart from the run's own numbers; null when no judge ran. */
  judge: (Usage & { calls: number; cacheHits?: number }) | null;
  /** What the decision checks cost, kept apart in the same way; null when no request was sent. */
  decision: (Usage & { calls: number }) | null;
  /**
   * The error, the cost (null when none was reported) and the duration of each earlier attempt, when `--retries` made the run again: a harness crash, a rate limit, or a timeout
   * before the harness produced any agent event. This record is the last attempt; its `attempt` in `results.jsonl` is the number
   * of the attempt. Absent when the run was made once.
   */
  attempts?: { error: string; costUsd: number | null; durationMs: number }[];
  /**
   * True when the command reached its `--max-cost` or `--max-duration` while this run was in flight, so its judged and
   * decision checks were not asked. Such a run is invalid, and `--resume` makes it again in full. Absent otherwise.
   */
  skippedGraders?: true;
}
