import type { By } from "../agents.js";
import { minOf } from "./defaults.js";
import { describeBy, fitsBy } from "../agents.js";
import type { ToolCall } from "../harnesses/shared.js";
import type { ToolMatcher } from "../matchers.js";
import {
  describeMatcher,
  firstOutside,
  hitsOf,
  matches,
  quoteCalls,
} from "../matchers.js";
import type { Outcome, RuledCheck, Spec, Verdict } from "./index.js";
import { checkBounds, checkLineBounds } from "./bounds.js";
import { PASS } from "./rules.js";
import { byNeeds, durationNeeds, unseenAgent } from "./by-needs.js";

const TOOL_FIELDS = {
  optional: [
    "kind",
    "name",
    "inputMatches",
    "flags",
    "inputLinesMax",
    "inputLinesMin",
    "minDurationMs",
    "maxDurationMs",
    "by",
    "dispatches",
  ],
  oneOf: ["kind", "name", "by", "dispatches"],
} satisfies Partial<Spec>;

const calls = (n: number): string =>
  `${String(n)} matching ${n === 1 ? "call" : "calls"}`;

// The matcher that a check's own kind, name, inputMatches and flags make.
const ownMatcher = ({
  kind,
  name,
  inputMatches,
  flags,
  inputLinesMax,
  inputLinesMin,
  minDurationMs,
  maxDurationMs,
  by,
  dispatches,
}: RuledCheck): ToolMatcher => ({
  ...(kind !== undefined && { kind }),
  ...(name !== undefined && { name }),
  ...(inputMatches !== undefined && { inputMatches }),
  ...(flags !== undefined && { flags }),
  ...(inputLinesMax !== undefined && { inputLinesMax }),
  ...(inputLinesMin !== undefined && { inputLinesMin }),
  ...(minDurationMs !== undefined && { minDurationMs }),
  ...(maxDurationMs !== undefined && { maxDurationMs }),
  ...(by !== undefined && { by }),
  ...(dispatches !== undefined && { dispatches }),
});

/**
 * Judges the call at a position against a matcher.
 * @param all - Every tool call of the run.
 * @param at - The position of the call to judge.
 * @param matcher - What that call must be.
 * @returns 1 when the call fits the matcher, and the reason it does not otherwise.
 */
function callFits(all: ToolCall[], at: number, matcher: ToolMatcher): Verdict {
  if (matches(matcher, all[at] as ToolCall)) return PASS;
  return {
    score: 0,
    reason: `the first tool call #${String(at)} does not match ${describeMatcher(matcher)}\n${quoteCalls(all, [at])}`,
  };
}

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
  if (at >= 0) return callFits(all, at, matcher);
  return {
    score: 0,
    reason: `${all.length === 0 ? "the run made no tool calls" : "no tool call is left after ignoring"}\n${quoteCalls(all, [])}`,
  };
}

/**
 * Judges the first call that an agent made.
 * @param all - Every tool call of the run.
 * @param matcher - What that call must be.
 * @param by - Whose first call it is.
 * @returns 1 when the agent's first call fits the matcher, and the reason it does not, or that it made none.
 */
function firstCallBy(all: ToolCall[], matcher: ToolMatcher, by: By): Verdict {
  const at = all.findIndex((call) => fitsBy(by, call.agent));
  if (at >= 0) return callFits(all, at, matcher);
  return {
    score: 0,
    reason: `${describeBy(by)} made no tool calls\n${quoteCalls(all, [])}`,
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
  const unseen = min === 0 ? unseenAgent(check, outcome) : undefined;
  if (unseen) return unseen;
  const matcher = ownMatcher(check);
  const all = outcome.toolCalls;
  if (check.first) {
    const { by, ...own } = matcher;
    const first =
      by === undefined
        ? firstCallFits(all, own, [])
        : firstCallBy(all, own, by);
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

// What `tool_not_called` fixes: no matching call at all.
const NOT_CALLED = { min: 0, max: 0 };

// The checks of the tool calls the agent made.
export const TOOL_CHECKS = {
  tool_called: {
    fields: [],
    ...TOOL_FIELDS,
    optional: [...TOOL_FIELDS.optional, "min", "max", "sameTurn", "first"],
    scores:
      "The agent made tool calls that fit every given field, and their number is from `min` to `max`. With `sameTurn`, they were all issued in one assistant turn.",
    note: "A count sees every call of the run, a subagent's included, unless `by` names the agent. With `by` alone (no `kind` or `name`) it counts every call of that agent, so `{ by: { agent: \"research-planner\" }, max: 0 }` says the planner made no tool call; `min` then defaults to 0 when `max` is 0. With `first` and `by`, the first call that agent made must fit, and with no `by` the run's first call. `sameTurn` needs a harness with `turnGrouping`; elsewhere the case is not applicable. `by` needs `childCalls`.",
    needs: (check) => [
      ...(check.sameTurn ? (["turnGrouping"] as const) : []),
      ...durationNeeds(check),
      ...byNeeds(check),
    ],
    validate: (given, where) => {
      checkBounds(given, where);
      checkLineBounds(given, where);
    },
    rule: (check, outcome) =>
      counted(check, outcome, {
        min: check.min ?? minOf(check),
        max: check.max ?? Infinity,
      }),
  },
  tool_not_called: {
    fields: [],
    ...TOOL_FIELDS,
    validate: checkLineBounds,
    needs: (check) => [...durationNeeds(check), ...byNeeds(check)],
    scores: "The agent made no tool call that fits every given field.",
    implied: NOT_CALLED,
    rule: (check, outcome) => counted(check, outcome, NOT_CALLED),
  },
  first_tool: {
    fields: ["matches"],
    optional: ["ignoring"],
    needs: (check) => [...durationNeeds(check), ...byNeeds(check)],
    scores:
      "The first tool call, once the calls that fit `ignoring` are dropped, fits `matches`.",
    note: "A subagent's calls are in the list too, unless `matches` or an `ignoring` matcher says `by`: `matches` with `by: \"main\"` fails when a subagent's call comes first.",
    rule: (check, outcome) =>
      firstCallFits(
        outcome.toolCalls,
        check.matches as ToolMatcher,
        check.ignoring ?? [],
      ),
  },
} satisfies Record<string, Spec>;
