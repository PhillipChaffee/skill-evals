import fs from "node:fs";
import path from "node:path";
import { ARCHIVE_SUFFIX, archiveRun } from "./archive.js";
import { messageOf } from "./scope.js";
import type { SessionResult } from "./session.js";
import type { RunPlan } from "./run-plan.js";

/** Where a run's archive is kept, as the record states it. */
export interface WorkspaceArchive {
  /** The archive's path, relative to the output directory. */
  path: string;
  bytes: number;
}

/**
 * Archives the run's files when the command was started with `--keep-workspaces`. The checks have run, so the archive
 * holds what they left. A failure is a warning and a record without an archive, never a lost run.
 * @param plan - The run: its harness, which names the login files, and where its files go.
 * @param ran - What the session produced, while its directories still exist.
 * @param stem - The run's path without an extension, as its stream file's.
 * @returns The archive's relative path and size; null when the run is not kept or the archive could not be made.
 */
export function keptArchive(
  plan: RunPlan,
  ran: SessionResult,
  stem: string,
): WorkspaceArchive | null {
  if (plan.keepWorkspaces !== true) return null;
  const target = `${stem}${ARCHIVE_SUFFIX}`;
  try {
    const bytes = archiveRun(
      { ...ran, authFiles: plan.harness.authFiles },
      target,
    );
    const relative = path.relative(path.resolve(plan.outDir), target);
    return { path: relative, bytes };
  } catch (error) {
    fs.rmSync(`${target}.partial`, { force: true });
    console.error(
      `skill-evals: warning: the workspace of ${plan.caseDef.id} could not be archived: ${messageOf(error)}`,
    );
    return null;
  }
}
