import type { RunRecord } from "./run.js";
import type { RunPlan } from "./run-plan.js";
import { bare } from "./run-plan.js";
import { NOT_REPORTED } from "./harnesses/shared.js";

/**
 * Makes the record of a run that broke while it was being scored, so that one bad run never ends the suite.
 * @param plan - The run.
 * @param message - What went wrong.
 * @returns An invalid record: it has an error and no score, and its checks are not scored.
 */
export function failedRecord(plan: RunPlan, message: string): RunRecord {
  const { harness, subject, caseDef, rep } = plan;
  const none = { created: [], modified: [], deleted: [] };
  return {
    harness: harness.id,
    subject: subject.label,
    caseId: caseDef.id,
    rep,
    ok: false,
    error: `the run could not be scored: ${message}`,
    finalText: "",
    toolCalls: [],
    skillsLoaded: [],
    skillEvents: [],
    transcriptFile: null,
    subjectLoaded: null,
    loaded: NOT_REPORTED,
    isolated: plan.isolated ?? false,
    unexpected: [],
    reportMissing: false,
    judgeProblem: null,
    subjectMutated: false,
    subjectChanges: null,
    changedFiles: none,
    checks: caseDef.checks.map((check) => ({
      ...bare(check),
      score: null,
      reason: "not scored, because the run is invalid",
    })),
    score: null,
    judge: null,
    decision: null,
    durationMs: 0,
    tokens: null,
    agentTokens: null,
    costUsd: null,
  };
}
