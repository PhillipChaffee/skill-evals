import type { LifecycleEvent, Loaded } from "./harnesses/shared.js";
import type { Check, Outcome, TurnSlice } from "./checks/index.js";
import type { Parsed, TranscriptEvent } from "./harnesses/shared.js";
import type { RunRecord } from "./run-plan.js";
import type { SkillEvent } from "./skill-events.js";
import type { ChangedFiles } from "./snapshot.js";

/** What a run left, as far as the turns are concerned. */
export interface TurnParts {
  /** The merged parse of the run; its events and calls carry their `userTurn`. */
  parsed: Pick<Parsed, "toolCalls" | "transcript">;
  /** The skill events of the whole run. */
  events: SkillEvent[];
  userTurns: TurnRecord[];
  /** What each turn changed in the workspace. */
  turnChanges: ChangedFiles[];
}

/** Why a turn was not sent: the run was stopped before it, or it is a reply to a question that was not asked. */
type SkipReason = "stopped" | "not asked";

/** What one turn of a case with `turns` was, and how it went. */
export interface TurnRecord {
  /** The turn's number, counted from 1. */
  turn: number;
  /** What the turn was: a message, a user invocation of a skill, a conditional reply, or a lifecycle event. */
  kind: "prompt" | "invoke" | "reply" | "event";
  /** The event, for a turn of kind `event`. */
  event?: LifecycleEvent;
  /** Why the turn was not sent; null for a turn that ran. */
  skipped: SkipReason | null;
  /** What stopped the run before this turn, for a turn that was not sent. */
  why?: string;
  /** What the agent finally said in this turn; empty for a turn that did not run or has no process. */
  finalText: string;
  /** What this turn's harness process reported as loaded at startup; null for a turn with no process. */
  loaded: Loaded | null;
  /** The session id this turn's process stated; null when it stated none or ran no process. */
  sessionId: string | null;
  /** What this turn's process reported of stopping for the user's answer (`Parsed.askedUser`); absent or null: nothing. */
  askedUser?: boolean | null;
}

const NONE: ChangedFiles = { created: [], modified: [], deleted: [] };

/**
 * Says why a turn did not run.
 * @param record - The turn's record.
 * @returns The reason a check of the turn reports; null for a turn that ran.
 */
const skippedFor = (record: TurnRecord): string | null =>
  record.skipped !== "stopped"
    ? null
    : `turn ${String(record.turn)} was not run: ${record.why || "the run was stopped before it"}`;

/**
 * Says why the checks of a reply turn that was not sent are not scored.
 * @param record - The turn's record.
 * @returns `not scored: turn N was not asked`; null for any other turn.
 */
const notAskedFor = (record: TurnRecord): string | null =>
  record.skipped === "not asked"
    ? `not scored: turn ${String(record.turn)} was not asked`
    : null;

/**
 * Cuts the run into the slice of each turn.
 * @param parts - The merged run, with what each turn said and changed.
 * @returns One slice for each turn: its events and calls, its final text, the skill loads of its calls (their `index`
 *   counted among the turn's calls, as the rules of the skill checks read it) and what it changed.
 */
export function slicesOf(parts: TurnParts): TurnSlice[] {
  const { toolCalls, transcript } = parts.parsed;
  return parts.userTurns.map((record, place): TurnSlice => {
    const calls = toolCalls.filter((call) => call.userTurn === record.turn);
    const first = toolCalls.findIndex((call) => call.userTurn === record.turn);
    const events = parts.events
      .filter((event) => toolCalls[event.index]?.userTurn === record.turn)
      .map((event) => ({ ...event, index: event.index - first }));
    return {
      finalText: record.finalText,
      toolCalls: calls,
      transcript: transcript.filter((one) => one.userTurn === record.turn),
      skillEvents: events,
      changed: parts.turnChanges[place] ?? NONE,
      callBase: Math.max(first, 0),
      skipped: skippedFor(record),
      notAsked: notAskedFor(record),
      askedUser: record.askedUser ?? null,
    };
  });
}

/**
 * Makes what a check observes.
 * @param check - Any check of a case.
 * @param outcome - What the run left behind.
 * @returns For a check of the case, the outcome as it is. For a check of a turn, the outcome with that turn's final
 *   text, calls, events and skill loads, and its workspace changes; a reason when the turn did not run, which scores
 *   the check 0 and says why, since a rule would find nothing and pass.
 */
export function viewFor(check: Check, outcome: Outcome): Outcome | string {
  if (check.turn === undefined) return outcome;
  const slice = outcome.turns?.[check.turn - 1];
  if (slice === undefined) return `turn ${String(check.turn)} has no record`;
  if (slice.skipped !== null) return slice.skipped;
  return {
    ...outcome,
    finalText: slice.finalText,
    toolCalls: slice.toolCalls,
    transcript: slice.transcript,
    skillEvents: slice.skillEvents,
    askedUser: slice.askedUser ?? null,
    turn: { changed: slice.changed, callBase: slice.callBase },
  };
}

/**
 * Tells whether a check belongs to a reply turn that was not sent.
 * @param check - Any check of a case.
 * @param outcome - What the run left behind.
 * @returns The reason the check is left out of the score; null for a check that is scored, which is every check but
 *   those of a reply turn that was not asked.
 */
export const notScoredFor = (check: Check, outcome: Outcome): string | null =>
  check.turn === undefined
    ? null
    : (outcome.turns?.[check.turn - 1]?.notAsked ?? null);

/**
 * Cuts a stored run into the slices of its turns, for a check that is scored again.
 * @param record - The stored run: its calls, skill events, turn records and what each turn changed.
 * @param transcript - The run's events, from its transcript file.
 * @returns The slices under `turns`; nothing for a run of a single prompt.
 */
export const storedSlices = (
  record: Pick<
    RunRecord,
    "toolCalls" | "skillEvents" | "userTurns" | "turnChanges"
  >,
  transcript: TranscriptEvent[],
): { turns?: TurnSlice[] } =>
  record.userTurns
    ? {
        turns: slicesOf({
          parsed: { toolCalls: record.toolCalls, transcript },
          events: record.skillEvents,
          userTurns: record.userTurns,
          turnChanges: record.turnChanges ?? [],
        }),
      }
    : {};
