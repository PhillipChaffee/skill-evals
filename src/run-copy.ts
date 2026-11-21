import path from "node:path";
import type { LoadedSubject } from "./harnesses/shared.js";
import type { RunCopy } from "./isolate.js";
import { copyForRun } from "./isolate.js";
import { UsageError } from "./scope.js";
import type { SessionResult } from "./session.js";
import type { ChangedFiles } from "./snapshot.js";
import { mergeChanges } from "./snapshot.js";
import type { Subject } from "./subject.js";
import { hasContent } from "./subject.js";

/** The copy of a subject that one run loads. */
export interface Copy extends RunCopy {
  /** What the harness is given: the subject with every path in the copy. */
  loaded: LoadedSubject;
}

/**
 * Copies a subject's export for one run.
 * @param subject - What the run loads.
 * @returns The copy; null for "none", which has no files.
 */
export function copyOf(subject: Subject): Copy | null {
  if (!hasContent(subject) || subject.exported === null) return null;
  const edited = subject.exportChanged();
  if (edited.length > 0) {
    throw new UsageError(
      `a run edited the exported copy of the subject, which every later run would load: ${edited.join(", ")}`,
    );
  }
  const copy = copyForRun(subject.exported);
  const { kind, skills } = subject;
  const skillDirs = Object.fromEntries(
    Object.entries(subject.skillDirs).map(([name, dir]) => [
      name,
      path.join(copy.dir, path.relative(subject.dir, dir)),
    ]),
  );
  return { ...copy, loaded: { kind, dir: copy.dir, skills, skillDirs } };
}

/**
 * Finds what a run changed in the subject it loaded.
 * @param copy - The run's copy of the subject; null for "none".
 * @param ran - What the session produced.
 * @returns The changes, null for "none", and whether what the agent saw could be watched. What the agent sees of a
 *   skills folder is the copies in its home, so those are watched too, and a skills folder is not observed without them.
 */
export function observe(
  copy: Copy | null,
  ran: SessionResult,
): { changes: ChangedFiles | null; observed: boolean } {
  const copied = copy?.changes() ?? null;
  const { placedChanges } = ran;
  return {
    changes:
      copied && placedChanges ? mergeChanges(copied, placedChanges) : copied,
    observed: copy?.loaded.kind !== "skills" || placedChanges !== null,
  };
}
