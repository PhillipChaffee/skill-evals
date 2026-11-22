import fs from "node:fs";
import path from "node:path";
import type { Unpacked } from "./archive.js";
import { unpackArchive } from "./archive.js";
import { allChecks } from "./case-checks.js";
import { existingHistory } from "./history-file.js";
import type { Case } from "./cases.js";
import type { Outcome } from "./checks/index.js";
import { commandContext } from "./command.js";
import { NO_ARCHIVE, splitChecks } from "./rescore-checks.js";
import type { RunRecord } from "./run.js";
import { assemble, invalidReason } from "./run.js";
import type { CheckResult, ScoringPlan } from "./run-plan.js";
import { fileState } from "./run-files.js";
import { scoreChecks } from "./score-checks.js";
import { UsageError, messageOf, tempDir } from "./scope.js";
import { allChanged, snapshot } from "./snapshot.js";
import type { TranscriptEvent } from "./harnesses/shared.js";
import { storedSlices } from "./turn-outcome.js";

export { NO_ARCHIVE };

/** What `rescore` needs besides the record and the case. */
export interface RescoreContext {
  /** The output directory that holds the record's transcript and archive. */
  outDir: string;
  /** How the judged and decision checks are scored; its cache is the run's own slot of the judge cache. */
  scoring: Omit<ScoringPlan, "caseDef" | "breached">;
  /** Keep the 0.0.1 rule for skill loads (`--lenient`). */
  lenient: boolean;
}

const GRADER_PREFIX = "copy-";

/**
 * Resolves a path that a record names.
 * @param outDir - The output directory the record was stored in.
 * @param relative - The path as the record has it.
 * @returns The absolute path.
 * @throws {UsageError} When the path leads out of the output directory.
 */
export function within(outDir: string, relative: string): string {
  const root = path.resolve(outDir);
  const found = path.resolve(root, relative);
  const inside = path.relative(root, found);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new UsageError(`${relative} is not inside ${outDir}`);
  }
  return found;
}

/**
 * Reads the transcript file of a run.
 * @param record - The stored run.
 * @param outDir - The output directory it was stored in.
 * @returns The run's events, whole.
 * @throws {UsageError} When the record names no transcript file, or the file is gone.
 */
function transcriptOf(
  record: RunRecord,
  outDir: string,
): { events: TranscriptEvent[]; file: string } {
  const named = record.transcriptFile;
  const file = named ? within(outDir, named) : null;
  if (file === null || !fs.existsSync(file)) {
    throw new UsageError(
      `${record.harness} ${record.caseId} ${record.subject}${String(record.rep)} has no transcript file in ${outDir}`,
    );
  }
  return {
    events: JSON.parse(fs.readFileSync(file, "utf8")) as TranscriptEvent[],
    file,
  };
}

/**
 * Copies the case's `grader/` directory for the command checks, as a run does after the agent exits.
 * @param caseDef - The current case.
 * @returns The copy and a `dispose`; null when the case has no grader.
 */
function graderCopy(
  caseDef: Case,
): { dir: string; dispose: () => void } | null {
  if (caseDef.graderDir === null) return null;
  const copy = tempDir(GRADER_PREFIX);
  fs.cpSync(caseDef.graderDir, copy.dir, {
    recursive: true,
    verbatimSymlinks: true,
  });
  return copy;
}

/**
 * Unpacks a run's archive.
 * @param archive - The archive's path.
 * @returns The unpacked directories.
 * @throws {UsageError} When `tar` cannot read the archive.
 */
function unpacked(archive: string): Unpacked {
  try {
    return unpackArchive(archive);
  } catch (error) {
    throw new UsageError(`${archive} cannot be unpacked: ${messageOf(error)}`);
  }
}

/**
 * Rebuilds what the `subject_unchanged` check observes.
 * @param record - The stored run.
 * @returns No directory, the paths the record says changed, and whether the copy could be watched.
 */
const subjectOf = (record: RunRecord): Outcome["subject"] => ({
  dir: null,
  mutated: record.subjectChanges ? allChanged(record.subjectChanges) : [],
  observed: record.subjectChanges !== null,
});

/**
 * Rebuilds what the checks of a run observe.
 * @param record - The stored run.
 * @param parts - The transcript, the unpacked archive (null without one) and the grader copy.
 * @param parts.transcript - The run's events and the path of their file.
 * @param parts.transcript.events - The events, whole.
 * @param parts.transcript.file - The path of the transcript file.
 * @param parts.files - The unpacked archive.
 * @param parts.grader - The copy of the grader directory.
 * @param context - The command's context, for the case's `env` and `lenient`.
 * @param context.env - The case's `env`.
 * @param context.lenient - Keep the 0.0.1 rule for skill loads, as `--lenient` does.
 * @returns The outcome. Without an archive the file fields are empty, and no check that reads them is scored.
 */
function outcomeOf(
  record: RunRecord,
  parts: {
    transcript: { events: TranscriptEvent[]; file: string };
    files: Unpacked | null;
    grader: string | null;
  },
  context: { env: Record<string, string>; lenient: boolean },
): Outcome {
  const { files } = parts;
  const none = new Map<string, string>();
  const state = files
    ? fileState({
        workspace: files.workspace,
        seed: snapshot(files.seedDir ?? files.workspace),
        home: files.home,
        homeSeed: files.homeSeed,
      })
    : {
        workspace: "",
        seed: none,
        changed: record.changedFiles,
        unlisted: [],
        home: "",
        homeSeed: none,
        homeChanged: { created: [], modified: [], deleted: [] },
        homeUnlisted: [],
      };
  return {
    ...storedSlices(record, parts.transcript.events),
    askedUser: record.askedUser ?? null,
    ...(record.askedUser === undefined ? { preQuestion: true as const } : {}),
    finalText: record.finalText,
    toolCalls: record.toolCalls,
    transcript: parts.transcript.events,
    skillEvents: record.skillEvents,
    loaded: record.loaded,
    legacySkillLoads: context.lenient,
    ...state,
    canaryChanges: record.canaryChanges ?? null,
    subject: subjectOf(record),
    command: commandContext(
      {
        workspace: state.workspace,
        home: state.home,
        graderDir: parts.grader,
        seedDir: files?.seedDir ?? null,
        remoteDir: files?.remoteDir ?? null,
      },
      context.env,
      {
        transcript: parts.transcript.file,
        history: existingHistory(parts.transcript.file),
      },
    ),
  };
}

/**
 * Puts the checks that were scored again and the ones that were not back in the case's order.
 * @param split - What `splitChecks` decided.
 * @param split.parts - For each check of the case: its place in `scored`, or the result it keeps.
 * @param scored - The results of the checks that were scored again.
 * @returns One result for each check of the case.
 */
const inOrder = (
  split: ReturnType<typeof splitChecks>,
  scored: CheckResult[],
): CheckResult[] =>
  split.parts.flatMap((part) => {
    const result = "kept" in part ? part.kept : scored[part.at];
    return result === undefined ? [] : [result];
  });

/**
 * Scores a stored run again against the case as it is now, without starting the agent. The outcome is rebuilt from
 * the run's transcript file and from its workspace archive unpacked into temp directories; every check of the case runs
 * again, and judged checks go through the cache the context holds. The run-level reasons for being invalid, a
 * harness error, an isolation breach and a subject that did not load, stay as the record has them: only the checks
 * change. A run that was stored with its judged checks skipped is finished. A run without an archive keeps the old
 * score of every check that needs the workspace or the home, with the reason `not re-scored: no workspace archive`; such
 * a check that is new to the case has no score.
 * @param record - The stored run.
 * @param caseDef - The case as it is now.
 * @param context - Where the run's files are, and how to score.
 * @returns The record with the new checks, score, judge and decision usage.
 * @throws {UsageError} When the run has no transcript file.
 */
export async function rescore(
  record: RunRecord,
  caseDef: Case,
  context: RescoreContext,
): Promise<RunRecord> {
  const transcript = transcriptOf(record, context.outDir);
  const archive = record.workspaceArchive?.path
    ? within(context.outDir, record.workspaceArchive.path)
    : null;
  const files =
    archive !== null && fs.existsSync(archive) ? unpacked(archive) : null;
  const split = splitChecks(record.checks, allChecks(caseDef), files !== null);
  const grader = files ? graderCopy(caseDef) : null;
  try {
    const outcome = outcomeOf(
      record,
      { transcript, files, grader: grader?.dir ?? null },
      { env: caseDef.env, lenient: context.lenient },
    );
    const kept = Object.fromEntries(
      Object.entries(record).filter(
        ([name]) => name !== "skippedGraders" && name !== "preconditions",
      ),
    ) as unknown as RunRecord;
    const base = { ...kept, checks: [] as CheckResult[] };
    const judgeable = invalidReason({ ...base, judgeProblem: null }) === null;
    const scored = await scoreChecks(
      { ...context.scoring, caseDef: { ...caseDef, checks: split.run } },
      outcome,
      judgeable,
    );
    const checks = inOrder(split, scored.checks);
    return assemble(base, { ...scored, checks }, record.costUsd).record;
  } finally {
    files?.dispose();
    grader?.dispose();
  }
}
