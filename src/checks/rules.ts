import type { CommandContext } from "../command.js";
import type { Loaded, ToolCall, TranscriptEvent } from "../harnesses/shared.js";
import type { SkillEvent } from "../skill-events.js";
import type { ChangedFiles, Snapshot } from "../snapshot.js";
import type { Field, Rule, Spec, Test, Verdict, With } from "./index.js";

/** The verdict of a check that holds. */
export const PASS: Verdict = { score: 1 };

/**
 * Compiles a pattern of a check.
 * @param pattern - The source of a regular expression.
 * @param flags - Its flags; none when absent.
 * @returns The expression.
 * @throws {SyntaxError} When the pattern or the flags are not valid.
 */
export const regex = (pattern: string, flags = ""): RegExp =>
  new RegExp(pattern, flags);

/**
 * Makes a check type whose rule scores 1 when a test holds, 0 when it does not.
 * @param fields - The fields the check requires. Loading a case reads each with its type's parser, which is what lets
 *   the test use them as set.
 * @param test - Looks at the check and the outcome.
 * @param more - What the spec says besides its fields and rule.
 * @returns The spec.
 */
export const holds = <F extends Field>(
  fields: F[],
  test: Test<F>,
  more: Omit<Spec, "fields" | "rule">,
): Spec & { rule: Rule } => ({
  fields,
  ...more,
  rule: (check, outcome) => ({
    score: Number(test(check as With<F>, outcome)),
  }),
});

/**
 * Makes a check type whose rule scores 1 when a test does not hold, 0 when it does.
 * @param fields - The fields the check requires.
 * @param test - Looks at the check and the outcome.
 * @param more - What the spec says besides its fields and rule.
 * @returns The spec.
 */
export const fails = <F extends Field>(
  fields: F[],
  test: Test<F>,
  more: Omit<Spec, "fields" | "rule">,
): Spec & { rule: Rule } =>
  holds(fields, (check, outcome) => !test(check, outcome), more);

/** What a check of one turn of a case with `turns` observes: that turn's part of the run. */
export interface TurnSlice {
  finalText: string;
  /** The turn's tool calls, in order; each keeps its position in the whole run as `index`. */
  toolCalls: ToolCall[];
  /** The turn's events. */
  transcript: TranscriptEvent[];
  /** The skill loads of the turn's calls, with `index` counted among the turn's calls. */
  skillEvents: SkillEvent[];
  /** What the turn created, modified and deleted in the workspace, from a hash taken after it. */
  changed: ChangedFiles;
  /** The run's number of the turn's first call, which a reason adds to a position to name a call as `show` does. */
  callBase: number;
  /** Why the turn did not run, as a reason a check reports; null for a turn that ran. */
  skipped: string | null;
}

/** What a deterministic check can observe. */
export interface Outcome {
  finalText: string;
  toolCalls: ToolCall[];
  /** The run's events: the assistant's text, each call and each result, in order. */
  transcript: TranscriptEvent[];
  /** Every call that gave the agent a skill or a file of one, with its mechanism and position. */
  skillEvents: SkillEvent[];
  /** What the harness said it loaded at startup; `skills` is null for a harness that lists none. */
  loaded: Loaded;
  /** True under `--lenient`: a `skill_loaded` or `skill_not_loaded` without `via` or `resolved` keeps the 0.0.1 rule. */
  legacySkillLoads?: boolean;
  workspace: string;
  /** The workspace as it was before the harness started: the hash of each file. */
  seed: Snapshot;
  /** What the run created, modified and deleted in the workspace, compared with `seed`. */
  changed: ChangedFiles;
  /** The directories of the workspace that could not be listed, before the run or after it. */
  unlisted: string[];
  /** The run's throwaway home, for a check with `root: "home"`. */
  home: string;
  /** The home just before the harness's prompt ran: auth files and placed skills are in it, so they never read as the agent's. */
  homeSeed: Snapshot;
  /** What the run created, modified and deleted in the home, compared with `homeSeed`. */
  homeChanged: ChangedFiles;
  /** The directories of the home that could not be listed, before the run or after it. */
  homeUnlisted: string[];
  /** The per-run copy of the subject the harness loaded, and the paths of it that the run changed. `observed` is false
   * when the copy the agent saw could not be watched, which no check may read as "unchanged". */
  subject: { dir: string | null; mutated: string[]; observed?: boolean };
  /** Where a `command` check runs and what it may read. */
  command: CommandContext;
  /** One slice for each turn of a case with `turns`, in order; a check with a `turn` reads that slice. */
  turns?: TurnSlice[];
  /** Set on the outcome that a check of one turn is scored with: what that turn changed in the workspace. */
  turn?: { changed: ChangedFiles; callBase: number };
}
