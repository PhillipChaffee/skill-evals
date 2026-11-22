import { normalizeAgent } from "../agents.js";
import type { Capability } from "../capabilities.js";
import type { ToolMatcher } from "../matchers.js";
import type { Check, Outcome, Verdict } from "./index.js";

const TEXT_CHECKS = ["transcript_matches", "transcript_lacks"];

/**
 * Lists the matchers inside a check, besides the check's own fields.
 * @param check - Any check.
 * @returns The matchers of `matches`, `before`, `after`, `ignoring`, `sequence` and `tool`, and of the `before` or
 *   `after` of a `scope` object.
 */
function matchersOf(check: Check): ToolMatcher[] {
  const { scope } = check;
  const inScope =
    scope !== undefined && typeof scope === "object"
      ? [
          ...("before" in scope ? [scope.before] : []),
          ...("after" in scope ? [scope.after] : []),
        ]
      : [];
  return [
    ...[check.matches, check.before, check.after, check.tool].flatMap(
      (one) => one ?? [],
    ),
    ...(check.ignoring ?? []),
    ...(check.sequence ?? []),
    ...inScope,
  ];
}

/**
 * Lists what a check on tool calls needs for its duration keys.
 * @param check - A check of tool calls.
 * @returns `toolDurations` when the check, or any matcher in it, sets `minDurationMs` or `maxDurationMs`; none otherwise.
 */
export function durationNeeds(check: Check): Capability[] {
  return [check, ...matchersOf(check)].some(
    (one) => one.minDurationMs !== undefined || one.maxDurationMs !== undefined,
  )
    ? ["toolDurations"]
    : [];
}

/**
 * Lists what a check needs for its `by` keys.
 * @param check - Any check.
 * @returns `subagents` when the check, or any matcher in it, has `dispatches`; `childText` when a `transcript_matches` or `transcript_lacks` check has a `by`; `childCalls` when any other
 *   check, or any matcher in a check, has one. Without the capability the main thread cannot be told from a subagent,
 *   so `by: "main"` would silently mean every agent.
 */
export function byNeeds(check: Check): Capability[] {
  const own = check.by !== undefined;
  const text = own && TEXT_CHECKS.includes(check.type);
  const calls =
    (own && !text) || matchersOf(check).some((one) => one.by !== undefined);
  const dispatches =
    check.dispatches !== undefined ||
    matchersOf(check).some((one) => one.dispatches !== undefined);
  return [
    ...(text ? (["childText"] as const) : []),
    ...(calls ? (["childCalls"] as const) : []),
    ...(dispatches ? (["subagents"] as const) : []),
  ];
}

/**
 * Applies the rule for a claim of absence about a named agent: it must have run.
 * @param check - A check that says an agent did not do something.
 * @param outcome - What the run left behind.
 * @returns A score of 0 with `no agent of type <name> ran` when the check's `by` or its `tool` matcher's `by` names an
 *   agent of which no event, call or skill load of the run is, and no dispatch call names it, since a typo or an agent
 *   that was never dispatched cannot be shown not to have done anything. A dispatched agent that produced no events
 *   did run, so a claim that it did nothing can hold; a generic dispatch (`general-purpose`) counts only as that type; undefined otherwise. `"main"` and `"subagent"` keep their plain
 *   meaning.
 */
export function unseenAgent(
  check: Check,
  outcome: Outcome,
): Verdict | undefined {
  const seen = new Set([
    ...[
      ...outcome.transcript.map((one) => one.agent),
      ...outcome.toolCalls.map((one) => one.agent),
      ...outcome.skillEvents.map((one) => one.agent),
    ].map((agent) => agent?.type ?? "main"),
    ...outcome.toolCalls.flatMap((call) =>
      call.kind === "subagent" && call.dispatch?.type
        ? [normalizeAgent(call.dispatch.type)]
        : [],
    ),
  ]);
  for (const by of [check.by, check.tool?.by]) {
    if (typeof by !== "object") continue;
    const type = normalizeAgent(by.agent);
    if (!seen.has(type)) {
      return { score: 0, reason: `no agent of type ${type} ran` };
    }
  }
  return undefined;
}
