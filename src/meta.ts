import { execFileSync } from "node:child_process";
import { exec } from "./exec.js";
import fs from "node:fs";
import type { Case } from "./cases.js";
import type { Located } from "./harnesses/index.js";
import type { HistoryMode } from "./history-types.js";
import { caseHash, toolVersion } from "./run-key.js";
import type { Subject } from "./subject.js";

const VERSION_TIMEOUT_MS = 10_000;
const MS_PER_SECOND = 1000;

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
  /**
   * The hash of each case as a run on that harness sees it, by harness id and case id. It is the hash that the run key
   * uses, so a check that the harness dropped (`ifUnsupported: "skip"`) is not in it.
   */
  caseHashes: Record<string, Record<string, string>>;
  /** Whether the command ran with `--isolated`. */
  isolated: boolean;
  /** Whether the command ran with `--lenient`. Absent from earlier results. */
  lenient?: boolean;
  /** The `--history-mode` of the command. Absent when it was not set, and from earlier results. */
  historyMode?: HistoryMode;
  /**
   * How the judged checks were scored: through the API or a harness session, which harness (null: the harness under
   * test), and which model. Absent from earlier results, which say it in `results.json`'s `judge` text.
   */
  judge?: {
    via: "api" | "harness";
    harness: string | null;
    model: string | null;
  };
}

/**
 * Asks a harness for its version, in a process group that is killed at the limit.
 * @param bin - The harness's executable.
 * @param timeoutMs - How long it may take.
 * @returns The first line it prints, trimmed; null when it fails, prints nothing or takes longer than the limit.
 */
async function versionOf(
  bin: string,
  timeoutMs: number,
): Promise<string | null> {
  const ran = await exec(bin, ["--version"], {
    cwd: process.cwd(),
    env: process.env,
    timeoutSeconds: timeoutMs / MS_PER_SECOND,
    reapOnExit: true,
    maxBytes: 4096,
  });
  return ran.failure === null
    ? ran.stdout.split("\n")[0]?.trim() || null
    : null;
}

/**
 * Tells whether the working tree has uncommitted changes under a subject's directory.
 * @param subject - The subject, whose `dir` and `commit` decide.
 * @returns False for a git ref; null for "none" and for a directory outside a git repository; else whether
 *   `git status` lists anything under the directory, untracked and ignored files included.
 */
export function dirtyOf(subject: Subject): boolean | null {
  if (subject.commit !== null) return false;
  if (subject.dir === null || !fs.existsSync(subject.dir)) return null;
  try {
    const status = execFileSync(
      "git",
      [
        ...["-C", subject.dir, "status", "--porcelain"],
        ...["--untracked-files=all", "--ignored", "--", "."],
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return status.trim() !== "";
  } catch {
    return null;
  }
}

/**
 * Reads each harness's version once, all at the same time.
 * @param located - Every harness the command will start: the ones that run a case, and the judge's when a judged check
 *   is selected.
 * @param timeoutMs - How long one harness may take before its process group is killed. Default: 10 seconds.
 * @returns The version of each, by harness id; a harness that appears twice is asked once.
 */
export async function harnessVersions(
  located: (Located | undefined)[],
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<Record<string, string | null>> {
  const unique = new Map<string, Located>();
  for (const entry of located) {
    if (entry !== undefined) unique.set(entry.harness.id, entry);
  }
  const asked = await Promise.all(
    [...unique].map(
      async ([id, entry]) =>
        [id, await versionOf(entry.bin, timeoutMs)] as const,
    ),
  );
  return Object.fromEntries(asked);
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
  /** For each harness id, the cases it runs, as a run sees them. */
  applied: Record<string, Case[]>;
  /** Whether the command ran with `--isolated`. */
  isolated: boolean;
  /** Whether the command ran with `--lenient`. */
  lenient: boolean;
  /** `--history-mode`; undefined when it was not set. */
  historyMode: HistoryMode | undefined;
  /** How the judged checks are scored. */
  judge: NonNullable<RunMeta["judge"]>;
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
    Object.entries(given.applied).map(([id, cases]) => [
      id,
      Object.fromEntries(cases.map((one) => [one.id, caseHash(one)])),
    ]),
  ),
  isolated: given.isolated,
  lenient: given.lenient,
  ...(given.historyMode === undefined
    ? {}
    : { historyMode: given.historyMode }),
  judge: given.judge,
});
