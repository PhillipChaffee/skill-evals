import os from "node:os";
import { allChecks } from "./case-checks.js";
import { canariesOf } from "./canaries.js";
import { maskingOf } from "./sandbox-masks.js";
import type { RunPlan, RunRecord } from "./run-plan.js";
import { relativeToHome } from "./rules-install.js";
import type { SessionResult } from "./session.js";
import type { SessionInput } from "./session-attempt.js";

/** The check type that needs the canaries watched. */
export const WRITES_CHECK = "no_writes_outside_workspace";

/**
 * Decides what confines a run and what watches it.
 * @param plan - The run.
 * @param subjectDir - The run's copy of the subject, which the sandbox lets the harness read.
 * @returns The sandbox, when `--sandbox` is on, with the case's `network`; and the canaries, when the case has a
 *   `no_writes_outside_workspace` check. Each is absent otherwise. The agent is told about neither.
 */
export function confinementOf(
  plan: Pick<
    RunPlan,
    | "sandbox"
    | "caseDef"
    | "harness"
    | "bin"
    | "projectRoot"
    | "casesDir"
    | "outDir"
  >,
  subjectDir?: string,
): Pick<SessionInput, "sandbox" | "canaries"> {
  const { sandbox, caseDef } = plan;
  const watched = allChecks(caseDef).some(
    (check) => check.type === WRITES_CHECK,
  );
  return {
    ...(sandbox && {
      sandbox: {
        backend: sandbox.backend,
        network: caseDef.network ?? "open",
        ...maskingOf({ ...plan, subjectDir }),
      },
    }),
    ...(watched && {
      canaries: {
        home: os.homedir(),
        canaries: canariesOf(plan.harness),
        root: plan.projectRoot ?? null,
        out: plan.outDir,
      },
    }),
  };
}

/**
 * Takes what a session did that a record states beside the run's files: what it did with the subject's rules, and what
 * changed in the canaries.
 * @param ran - What the session produced.
 * @returns The record's `rules` (nothing when the subject names none) and `canaryChanges` (nothing when the case did not
 *   watch them).
 */
export const extrasOf = (
  ran: SessionResult,
): Pick<RunRecord, "rules" | "canaryChanges"> => ({
  ...(ran.rulesInstalled && {
    rules: {
      installed: ran.rulesInstalled,
      reportedLoaded: relativeToHome(ran.home, ran.parsed.loaded.rules),
    },
  }),
  ...(ran.canaryChanges && { canaryChanges: ran.canaryChanges }),
});
