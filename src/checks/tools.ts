import type { ToolCall } from "../harnesses/shared.js";
import type { ToolMatcher } from "../matchers.js";
import { describeMatcher, matches, quoteCalls } from "../matchers.js";
import { UsageError } from "../scope.js";
import type { Outcome, RuledCheck, Spec, Verdict } from "./index.js";

const TOOL_FIELDS = {
  optional: ["kind", "name", "inputMatches", "flags"],
  oneOf: ["kind", "name"],
} satisfies Partial<Spec>;

const PASS: Verdict = { score: 1 };
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
  const at = all.findIndex(
    (call) => !ignoring.some((one) => matches(one, call)),
  );
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
 * Finds the most matching calls that one turn issued.
 * @param all - Every tool call of the run.
 * @param hits - The positions of the matching calls.
 * @returns The largest group of matching calls with one turn; a call with no turn is a turn of its own.
 */
function mostInOneTurn(all: ToolCall[], hits: number[]): number {
  const perTurn = new Map<string, number>();
  for (const at of hits) {
    const key = String(all[at]?.turn ?? `call ${String(at)}`);
    perTurn.set(key, (perTurn.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...perTurn.values());
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
  const hits = all.flatMap((call, at) => (matches(matcher, call) ? [at] : []));
  const sameTurn = check.sameTurn === true;
  const count = sameTurn ? mostInOneTurn(all, hits) : hits.length;
  if (count >= min && count <= max) return PASS;
  const found = sameTurn ? `at most ${calls(count)} in one turn` : calls(count);
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
      "The agent made tool calls that fit every given field, and their number is from `min` to `max`.",
    note: "A count sees every call of the run, a subagent's included: calls cannot yet be told apart by the agent that made them. `sameTurn` needs a harness with `turnGrouping`; elsewhere the case is not applicable.",
    needs: (check) => (check.sameTurn ? ["turnGrouping"] : []),
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
