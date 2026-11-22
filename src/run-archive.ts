import fs from "node:fs";
import path from "node:path";
import type { Staged } from "./archive.js";
import { ARCHIVE_SUFFIX, stageRun, writeArchive } from "./archive.js";
import { messageOf } from "./scope.js";
import type { SessionResult } from "./session.js";
import type { RunPlan } from "./run-plan.js";

/** Where a run's archive is kept, as the record states it. */
export interface WorkspaceArchive {
  /** The archive's path, relative to the output directory. */
  path: string;
  bytes: number;
  /** The files left out because their content is a login file's, as paths in the archive's layout. */
  omitted?: string[];
}

// An archive this large is worth a word to the user: a workspace may hold a build.
const KIB = 1024;
const ARCHIVE_WARN_BYTES = KIB * KIB * KIB;

/**
 * Copies the run's files for an archive when the command was started with `--keep-workspaces`. It runs before the
 * checks, so that nothing a `command` check writes, such as a copy of the grader's files, reaches the archive, and so
 * that a rescore starts from the files the checks started from.
 * @param plan - The run: its harness, which names the login files.
 * @param ran - What the session produced, while its directories still exist.
 * @returns The staged files; null when the run is not kept or the copy failed, which is a warning and never a lost run.
 */
export function stageKept(plan: RunPlan, ran: SessionResult): Staged | null {
  if (plan.keepWorkspaces !== true) return null;
  try {
    return stageRun({ ...ran, authFiles: plan.harness.authFiles });
  } catch (error) {
    console.error(
      `skill-evals: warning: the workspace of ${plan.caseDef.id} could not be archived: ${messageOf(error)}`,
    );
    return null;
  }
}

/**
 * Writes the staged files of a run to its archive.
 * @param plan - The run: where its files go.
 * @param staged - What `stageKept` made; null for no archive.
 * @param stem - The run's path without an extension, as its stream file's.
 * @returns The archive's relative path and size; null when there is none or `tar` failed.
 */
export function keptArchive(
  plan: RunPlan,
  staged: Staged | null,
  stem: string,
): WorkspaceArchive | null {
  if (staged === null) return null;
  const target = `${stem}${ARCHIVE_SUFFIX}`;
  try {
    const { omitted } = staged;
    const bytes = writeArchive(staged, target);
    if (bytes > ARCHIVE_WARN_BYTES) {
      console.error(
        `skill-evals: warning: the archive ${target} is ${String(bytes)} bytes; delete it when you no longer need it`,
      );
    }
    return {
      path: path.relative(path.resolve(plan.outDir), target),
      bytes,
      omitted,
    };
  } catch (error) {
    fs.rmSync(`${target}.partial`, { force: true });
    console.error(
      `skill-evals: warning: the workspace of ${plan.caseDef.id} could not be archived: ${messageOf(error)}`,
    );
    return null;
  }
}
