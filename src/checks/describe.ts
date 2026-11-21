import { describeMatcher } from "../matchers.js";
import type { EndMatcher } from "../matchers.js";
import type { Check } from "./index.js";

// A matcher of `before` or `after`, with the end of the matching calls that counts.
const end = (name: string, matcher: EndMatcher): string =>
  `${name} ${describeMatcher(matcher)}${matcher.which === undefined ? "" : ` (${matcher.which})`}`;

/**
 * Names what distinguishes a check that looks at tool calls, beyond its type and the fields every check shows.
 * @param check - Any check of a case.
 * @returns The words for its matchers, count bounds, `anyOf` and flags; none for a check without them.
 */
export function describeCalls(check: Check): string[] {
  const { before, after, sequence, matches, ignoring } = check;
  return [
    ...(before ? [end("before", before)] : []),
    ...(after ? [end("after", after)] : []),
    ...(sequence
      ? [`sequence ${sequence.map(describeMatcher).join(" > ")}`]
      : []),
    ...(check.strict ? ["strict"] : []),
    ...(matches ? [`matches ${describeMatcher(matches)}`] : []),
    ...(ignoring
      ? [`ignoring ${ignoring.map(describeMatcher).join(", ")}`]
      : []),
    ...(check.anyOf ? [`anyOf ${check.anyOf.join(", ")}`] : []),
    ...(check.min === undefined ? [] : [`min ${String(check.min)}`]),
    ...(check.max === undefined ? [] : [`max ${String(check.max)}`]),
    ...(check.sameTurn ? ["sameTurn"] : []),
    ...(check.first ? ["first"] : []),
  ];
}
