import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { Case } from "./cases.js";
import type { Located } from "./harnesses/index.js";
import { caseHash, toolVersion } from "./run-key.js";
import type { Subject } from "./subject.js";

const VERSION_TIMEOUT_MS = 10_000;

/** What a command records about how its runs were made, so that a number can be traced to its tools. */
export interface RunMeta {
  /** The version of this package. */
  toolVersion: string;
  /** For each harness that the command could start, the first line of `<bin> --version`; null when that failed. */
  harnessVersions: Record<string, string | null>;
  /** The models of the agent, the judge and the decision checks; null when not set. */
  models: {
    agent: string | null;
    judge: string | null;
    decision: string | null;
  };
  /**
   * The subjects. `revision` is the content hash of what a run loads. `dirty` is true when the working tree has
   * uncommitted changes under the subject's path, false for a git ref, and null when the subject is not in a git
   * repository or is "none".
   */
  subjects: { label: string; revision: string; dirty: boolean | null }[];
  /** The hash of each case as a run sees it, by case id. */
  caseHashes: Record<string, string>;
  /** Whether the command ran with `--isolated`. */
  isolated: boolean;
}

/**
 * Asks a harness for its version.
 * @param bin - The harness's executable.
 * @returns The first line it prints, trimmed; null when it fails, prints nothing or takes longer than 10 seconds.
 */
function versionOf(bin: string): string | null {
  try {
    const text = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: VERSION_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return text.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Tells whether the working tree has uncommitted changes under a subject's directory.
 * @param subject - The subject, whose `dir` and `commit` decide.
 * @returns False for a git ref; null for "none" and for a directory outside a git repository; else whether
 *   `git status` lists anything under the directory, untracked files included.
 */
export function dirtyOf(subject: Subject): boolean | null {
  if (subject.commit !== null) return false;
  if (subject.dir === null || !fs.existsSync(subject.dir)) return null;
  try {
    const status = execFileSync(
      "git",
      ["-C", subject.dir, "status", "--porcelain", "--", "."],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return status.trim() !== "";
  } catch {
    return null;
  }
}

/**
 * Reads each harness's version once.
 * @param located - Every harness the command may start: the ones under test and the judge's.
 * @returns The version of each, by harness id; a harness that appears twice is asked once.
 */
export function harnessVersions(
  located: (Located | undefined)[],
): Record<string, string | null> {
  const versions: Record<string, string | null> = {};
  for (const entry of located) {
    if (entry !== undefined && !(entry.harness.id in versions)) {
      versions[entry.harness.id] = versionOf(entry.bin);
    }
  }
  return versions;
}

/** What `runMetaOf` gathers the metadata from. */
interface MetaInput {
  /** The harness versions, read once before the runs. */
  versions: Record<string, string | null>;
  /** The agent, judge and decision models; undefined is unset. */
  models: {
    agent: string | undefined;
    judge: string | undefined;
    decision: string | undefined;
  };
  /** The resolved subjects. */
  subjects: Subject[];
  /** Every loaded case. */
  cases: Case[];
  /** Whether the command ran with `--isolated`. */
  isolated: boolean;
}

/**
 * Gathers the metadata of a command.
 * @param given - What the command was made with.
 * @returns The metadata, written to `results.json` as `meta`.
 */
export const runMetaOf = (given: MetaInput): RunMeta => ({
  toolVersion: toolVersion(),
  harnessVersions: given.versions,
  models: {
    agent: given.models.agent ?? null,
    judge: given.models.judge ?? null,
    decision: given.models.decision ?? null,
  },
  subjects: given.subjects.map((subject) => ({
    label: subject.label,
    revision: subject.revision,
    dirty: dirtyOf(subject),
  })),
  caseHashes: Object.fromEntries(
    given.cases.map((one) => [one.id, caseHash(one)]),
  ),
  isolated: given.isolated,
});
