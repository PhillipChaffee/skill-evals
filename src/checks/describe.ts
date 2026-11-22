import { describeBy } from "../agents.js";
import { describeMatcher } from "../matchers.js";
import type { EndMatcher } from "../matchers.js";
import type { Check, JudgedCheck } from "./index.js";

// A matcher of `before` or `after`, with the end of the matching calls that counts.
const end = (name: string, matcher: EndMatcher): string =>
  `${name} ${describeMatcher(matcher)}${matcher.which === undefined ? "" : ` (${matcher.which})`}`;

/**
 * Names the bounds on a call's input lines and duration.
 * @param check - Any check of a case.
 * @returns The words for `inputLinesMax`, `inputLinesMin`, `minDurationMs` and `maxDurationMs`; none for a check without them.
 */
const describeLimits = (check: Check): string[] =>
  (
    [
      "inputLinesMax",
      "inputLinesMin",
      "minDurationMs",
      "maxDurationMs",
    ] as const
  ).flatMap((key) =>
    check[key] === undefined ? [] : [`${key} ${String(check[key])}`],
  );

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
    ...(check.agent === undefined ? [] : [`agent ${check.agent}`]),
    ...(check.dispatches === undefined
      ? []
      : [`dispatches ${check.dispatches}`]),
    ...(check.briefWindow === undefined
      ? []
      : [`briefWindow ${String(check.briefWindow)}`]),
    ...(check.min === undefined ? [] : [`min ${String(check.min)}`]),
    ...(check.max === undefined ? [] : [`max ${String(check.max)}`]),
    ...(check.sameTurn ? ["sameTurn"] : []),
    ...(check.first ? ["first"] : []),
    ...(check.by === undefined ? [] : [`by ${describeBy(check.by)}`]),
    ...describeLimits(check),
  ];
}

/**
 * Names what distinguishes a check of assistant text or tool outputs.
 * @param check - Any check of a case.
 * @returns The words for its scope, where, tool, which and size bound; none for a check without them.
 */
export function describeTranscript(check: Check): string[] {
  const { scope, tool, which, maxBytes } = check;
  return [
    ...(scope === undefined
      ? []
      : [`scope ${typeof scope === "string" ? scope : JSON.stringify(scope)}`]),
    ...(check.where ? [`where ${check.where}`] : []),
    ...(tool ? [`tool ${describeMatcher(tool)}`] : []),
    ...(which ? [`which ${which}`] : []),
    ...(maxBytes === undefined ? [] : [`maxBytes ${String(maxBytes)}`]),
  ];
}

/**
 * Names what distinguishes a check that looks at files, beyond its type and path.
 * @param check - Any check of a case.
 * @returns The words for its quantifier, root, `created`, `allow` and `ignore`; none for a check without them.
 */
export function describeFiles(check: Check): string[] {
  return [
    ...(check.quantifier ? [`quantifier ${check.quantifier}`] : []),
    ...(check.root ? [`root ${check.root}`] : []),
    ...(check.created ? ["created"] : []),
    ...(check.allow ? [`allow ${check.allow.join(", ")}`] : []),
    ...(check.ignore ? [`ignore ${check.ignore.join(", ")}`] : []),
  ];
}

/**
 * Names what a check of hooks or injected context looks at.
 * @param check - Any check of a case.
 * @returns The words for its `event` and its `source`; none for a check without them.
 */
export const describeHooks = (check: Check): string[] => [
  ...(check.event === undefined ? [] : [`event ${check.event}`]),
  ...(check.source === undefined ? [] : [`source ${check.source}`]),
];

/**
 * Names what a judge or decision check is shown and how it scores, beyond its type and rubric.
 * @param check - Any check of a case.
 * @returns The words for its scale, votes, `sees` other than the default, and `files`; none for a check without them.
 */
export function describeSeen(check: Check): string[] {
  const { sees, files } = check;
  const shown = sees?.join("+");
  const { scale, votes } = check.type === "judge" ? check : ({} as JudgedCheck);
  return [
    ...(typeof check.rubric === "object" ? ["pass/fail rubric"] : []),
    ...(scale === undefined ? [] : [`scale ${scale}`]),
    ...(votes === undefined ? [] : [`votes ${String(votes)}`]),
    ...(shown === undefined || shown === "final" ? [] : [`sees ${shown}`]),
    ...(files ? [`files ${files.join(", ")}`] : []),
  ];
}
