import type { ToolCall } from "../harnesses/shared.js";
import type { ToolMatcher } from "../matchers.js";
import {
  describeMatcher,
  firstOutside,
  hitsOf,
  matches,
  quoteCalls,
} from "../matchers.js";
import { UsageError } from "../scope.js";
import type { Outcome, RuledCheck, Spec, Verdict } from "./index.js";
import { PASS } from "./rules.js";

const TOOL_FIELDS = {
  optional: ["kind", "name", "inputMatches", "flags"],
  oneOf: ["kind", "name"],
} satisfies Partial<Spec>;

const calls = (n: number): string =>
  `${String(n)} matching ${n === 1 ? "call" : "calls"}`;

// The matcher that a check's own kind, name, inputMatches and flags make.
const ownMatcher = ({
  kind,
  name,
  inputMatches,
  flags,
}: RuledCheck): ToolMatcher => ({
  ...(kind !== undefined && { kind }),
  ...(name !== undefined && { name }),
  ...(inputMatches !== undefined && { inputMatches }),
  ...(flags !== undefined && { flags }),
});

/**
 * Judges the first call that is left after dropping the ignored ones.
 * @param all - Every tool call of the run.
 * @param matcher - What that call must be.
 * @param ignoring - Calls to drop first.
 * @returns 1 when the first call left fits the matcher, and the reason it does not otherwise.
 */
function firstCallFits(
  all: ToolCall[],
  matcher: ToolMatcher,
  ignoring: ToolMatcher[],
): Verdict {
  const at = firstOutside(all, ignoring);
  if (at < 0) {
    return {
      score: 0,
      reason: `${all.length === 0 ? "the run made no tool calls" : "no tool call is left after ignoring"}\n${quoteCalls(all, [])}`,
    };
  }
  if (matches(matcher, all[at] as ToolCall)) return PASS;
  return {
    score: 0,
    reason: `the first tool call #${String(at)} does not match ${describeMatcher(matcher)}\n${quoteCalls(all, [at])}`,
  };
}

/**
 * Tells whether the matching calls were all issued in one assistant turn.
 * @param all - Every tool call of the run.
 * @param hits - The positions of the matching calls.
 * @returns Null when they were, or when there is at most one; else the position of the first call that is in another
 *   turn than the first match, or has no turn and so cannot be shown to share it.
 */
function straggler(all: ToolCall[], hits: number[]): number | null {
  const [head] = hits;
  if (head === undefined) return null;
  const turn = all[head]?.turn;
  return (
    hits.slice(1).find((at) => turn === undefined || all[at]?.turn !== turn) ??
    null
  );
}

/**
 * Scores how many calls fit a check, and whether the first one does when the check says so.
 * @param check - A check whose matcher fields, `first` and `sameTurn` are read.
 * @param outcome - What the run left behind.
 * @param bounds - The fewest and the most matching calls.
 * @param bounds.min - The fewest.
 * @param bounds.max - The most.
 * @returns 1 when the count is within bounds, and the reason it is not otherwise.
 */
function counted(
  check: RuledCheck,
  outcome: Outcome,
  bounds: { min: number; max: number },
): Verdict {
  const { min, max } = bounds;
  const matcher = ownMatcher(check);
  const all = outcome.toolCalls;
  if (check.first) {
    const first = firstCallFits(all, matcher, []);
    if (first.score === 0) return first;
  }
  const hits = hitsOf(all, matcher);
  const apart = check.sameTurn ? straggler(all, hits) : null;
  if (apart !== null) {
    const turn = (at: number): string => String(all[at]?.turn ?? "unknown");
    return {
      score: 0,
      reason: `the matching calls were not all issued in one turn: call #${String(apart)} is in turn ${turn(apart)}, call #${String(hits[0])} in turn ${turn(hits[0] ?? 0)}, for ${describeMatcher(matcher)}\n${quoteCalls(all, [apart])}`,
    };
  }
  const count = hits.length;
  if (count >= min && count <= max) return PASS;
  const found = calls(count);
  const bound = count < min ? `min ${String(min)}` : `max ${String(max)}`;
  return {
    score: 0,
    reason: `${found}, ${bound}, for ${describeMatcher(matcher)}\n${quoteCalls(all, hits)}`,
  };
}

/**
 * Checks the fields of a count together.
 * @param given - The fields that are set.
 * @param where - Names the file and the check in an error message.
 * @throws {UsageError} When `min` is above `max`.
 */
function checkBounds(given: Record<string, unknown>, where: string): void {
  const { min, max } = given;
  if (typeof min === "number" && typeof max === "number" && min > max) {
    throw new UsageError(
      `${where}: "min" ${String(min)} is above "max" ${String(max)}`,
    );
  }
}

// The checks of the tool calls the agent made.
export const TOOL_CHECKS = {
  tool_called: {
    fields: [],
    ...TOOL_FIELDS,
    optional: [...TOOL_FIELDS.optional, "min", "max", "sameTurn", "first"],
    scores:
      "The agent made tool calls that fit every given field, and their number is from `min` to `max`. With `sameTurn`, they were all issued in one assistant turn.",
    note: "A count sees every call of the run, a subagent's included: calls cannot yet be told apart by the agent that made them. `sameTurn` needs a harness with `turnGrouping`; elsewhere the case is not applicable.",
    needs: (check) => (check.sameTurn ? ["turnGrouping"] : []),
    notYet: ["by", "inputLinesMax"],
    validate: checkBounds,
    rule: (check, outcome) =>
      counted(check, outcome, {
        min: check.min ?? 1,
        max: check.max ?? Infinity,
      }),
  },
  tool_not_called: {
    fields: [],
    ...TOOL_FIELDS,
    notYet: ["by", "inputLinesMax"],
    scores: "The agent made no tool call that fits every given field.",
    rule: (check, outcome) => counted(check, outcome, { min: 0, max: 0 }),
  },
  first_tool: {
    fields: ["matches"],
    optional: ["ignoring"],
    scores:
      "The first tool call, once the calls that fit `ignoring` are dropped, fits `matches`.",
    note: "A subagent's calls are in the list too, because calls cannot yet be told apart by the agent that made them.",
    rule: (check, outcome) =>
      firstCallFits(
        outcome.toolCalls,
        check.matches as ToolMatcher,
        check.ignoring ?? [],
      ),
  },
} satisfies Record<string, Spec>;
