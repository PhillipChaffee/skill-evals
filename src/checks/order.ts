import type { ToolCall } from "../harnesses/shared.js";
import type { EndMatcher, ToolMatcher } from "../matchers.js";
import { describeMatcher, hitsOf, quoteCalls } from "../matchers.js";
import { UsageError } from "../scope.js";
import type { Spec, Verdict } from "./index.js";
import { PASS } from "./rules.js";

/**
 * Scores the pair form: one end of the `before` calls comes before one end of the `after` calls.
 * @param all - Every tool call of the run.
 * @param ends - The two matchers by their names.
 * @param ends.before - The calls that must come first.
 * @param ends.after - The calls that must come second.
 * @returns 1 when both sides match and the chosen `before` call is earlier than the chosen `after` call.
 */
function inPair(
  all: ToolCall[],
  ends: { before: EndMatcher; after: EndMatcher },
): Verdict {
  const chosen: number[] = [];
  for (const side of ["before", "after"] as const) {
    const matcher = ends[side];
    const hits = hitsOf(all, matcher);
    const at = matcher.which === "last" ? hits.at(-1) : hits[0];
    if (at === undefined) {
      return {
        score: 0,
        reason: `no call matches "${side}" ${describeMatcher(matcher)}\n${quoteCalls(all, [])}`,
      };
    }
    chosen.push(at);
  }
  const [early = 0, late = 0] = chosen;
  if (early < late) return PASS;
  const name = (side: EndMatcher): string =>
    `the ${side.which ?? "first"} ${side.kind ?? "matching"} call`;
  return {
    score: 0,
    reason: `${name(ends.before)} #${String(early)} is not before ${name(ends.after)} #${String(late)}\n${quoteCalls(all, chosen)}`,
  };
}

/**
 * Finds the first match of each matcher of a sequence, each after the one before it.
 * @param all - Every tool call of the run.
 * @param sequence - The matchers, in order.
 * @param hits - The positions of the calls that fit each matcher.
 * @returns The positions, or the verdict of the matcher that matches no call after the one before it.
 */
function firstMatches(
  all: ToolCall[],
  sequence: ToolMatcher[],
  hits: number[][],
): number[] | Verdict {
  const firsts: number[] = [];
  for (const [step, matcher] of sequence.entries()) {
    const after = firsts.at(-1) ?? -1;
    const at = hits[step]?.find((position) => position > after);
    if (at === undefined) {
      const when = step === 0 ? "" : ` after call #${String(after)}`;
      return {
        score: 0,
        reason: `sequence[${String(step)}] matches no call${when}, for ${describeMatcher(matcher)}\n${quoteCalls(all, firsts)}`,
      };
    }
    firsts.push(at);
  }
  return firsts;
}

/** A call that breaks the order of a strict sequence, and what it breaks. */
interface Disorder {
  reason: string;
  /** The position of the offending call. */
  at: number;
}

/**
 * Finds a call that breaks the order of a strict sequence.
 * @param hits - The positions of the calls that fit each matcher.
 * @param firsts - The first match of each.
 * @returns The first call that does, or null when none does.
 */
function disorder(hits: number[][], firsts: number[]): Disorder | null {
  for (let early = 0; early < hits.length; early++) {
    for (let step = early + 1; step < hits.length; step++) {
      const before = hits[step]?.find((at) => at < (firsts[early] ?? 0));
      if (before !== undefined) {
        const reason = `sequence[${String(step)}] matches call #${String(before)} before call #${String(firsts[early])}`;
        return { reason, at: before };
      }
      const after = hits[early]?.find((at) => at > (firsts[step] ?? 0));
      if (after !== undefined) {
        const reason = `sequence[${String(early)}] matches call #${String(after)} after call #${String(firsts[step])}`;
        return { reason, at: after };
      }
    }
  }
  return null;
}

/**
 * Scores the sequence form.
 * @param all - Every tool call of the run.
 * @param sequence - The matchers, in order.
 * @param strict - True to forbid a call that breaks the order, besides requiring the order.
 * @returns 1 when the matchers match in order, and with `strict` no call breaks it.
 */
function inSequence(
  all: ToolCall[],
  sequence: ToolMatcher[],
  strict: boolean,
): Verdict {
  const hits = sequence.map((matcher) => hitsOf(all, matcher));
  const firsts = firstMatches(all, sequence, hits);
  if (!Array.isArray(firsts)) return firsts;
  const broken = strict ? disorder(hits, firsts) : null;
  if (broken === null) return PASS;
  return {
    score: 0,
    reason: `${broken.reason}\n${quoteCalls(all, [...firsts, broken.at])}`,
  };
}

/**
 * Checks the fields of an order check together.
 * @param given - The fields that are set.
 * @param where - Names the file and the check in an error message.
 * @throws {UsageError} Unless exactly one of the pair form and the sequence form is given, and `strict` goes with a
 *   sequence.
 */
function checkForm(given: Record<string, unknown>, where: string): void {
  const pair = ["before", "after"].filter((key) => key in given);
  const sequence = "sequence" in given;
  if (sequence === pair.length > 0) {
    throw new UsageError(
      `${where}: tool_order needs exactly one of "before" with "after", and "sequence"`,
    );
  }
  if (!sequence && pair.length === 1) {
    throw new UsageError(`${where}: "before" and "after" go together`);
  }
  if (!sequence && "strict" in given) {
    throw new UsageError(`${where}: "strict" only applies with "sequence"`);
  }
}

// The check of the order of tool calls.
export const ORDER_CHECKS = {
  tool_order: {
    fields: [],
    forms: [["before", "after"], ["sequence"]],
    together: { strict: ["sequence"] },
    optional: ["before", "after", "sequence", "strict"],
    scores:
      "The calls come in the order given: with `before` and `after`, the chosen `before` call is earlier than the chosen `after` call; with `sequence`, the matchers match calls in that order.",
    note: "It takes exactly one of the pair `before` and `after`, and `sequence`. With `strict: true` a sequence also forbids a later matcher's call before an earlier matcher's first match, and an earlier matcher's call after a later matcher's first match: `[researcher, synthesizer]` allows two researchers, then the synthesizer, and no researcher after it. The check sees every call of the run, a subagent's included: calls cannot yet be told apart by the agent that made them.",
    validate: checkForm,
    rule: ({ before, after, sequence, strict }, { toolCalls }) =>
      sequence
        ? inSequence(toolCalls, sequence, strict === true)
        : inPair(toolCalls, {
            before: before as EndMatcher,
            after: after as EndMatcher,
          }),
  },
} satisfies Record<string, Spec>;
