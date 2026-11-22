import type { Capability } from "../capabilities.js";
import type { Check } from "./index.js";

const TEXT_CHECKS = ["transcript_matches", "transcript_lacks"];

/**
 * Lists the matchers inside a check, besides the check's own fields.
 * @param check - Any check.
 * @returns The matchers of `matches`, `before`, `after`, `ignoring`, `sequence` and `tool`, and of the `before` or
 *   `after` of a `scope` object.
 */
function matchersOf(check: Check): { by?: unknown }[] {
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
 * Lists what a check needs for its `by` keys.
 * @param check - Any check.
 * @returns `childText` when a `transcript_matches` or `transcript_lacks` check has a `by`; `childCalls` when any other
 *   check, or any matcher in a check, has one. Without the capability the main thread cannot be told from a subagent,
 *   so `by: "main"` would silently mean every agent.
 */
export function byNeeds(check: Check): Capability[] {
  const own = check.by !== undefined;
  const text = own && TEXT_CHECKS.includes(check.type);
  const calls =
    (own && !text) || matchersOf(check).some((one) => one.by !== undefined);
  return [
    ...(text ? (["childText"] as const) : []),
    ...(calls ? (["childCalls"] as const) : []),
  ];
}
