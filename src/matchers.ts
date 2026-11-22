import type { FieldDef, FieldParser } from "./checks/fields.js";
import { FIELDS, readField, registerParser } from "./checks/fields.js";
import { checkLineBounds } from "./checks/bounds.js";
import { regex } from "./checks/rules.js";
import type { By } from "./agents.js";
import { fitsBy, normalizeAgent } from "./agents.js";
import { ruleOf } from "./dispatch-rule.js";
import type { ToolCall, ToolKind } from "./harnesses/shared.js";
import { countLines, longestString } from "./lines.js";
import { UsageError } from "./scope.js";

/**
 * Describes tool calls: the one shape that every check that looks at calls uses. Every key that is set must fit.
 * The flags apply to `name` and `inputMatches` of this matcher only.
 */
export interface ToolMatcher {
  kind?: ToolKind;
  /** A regular expression for the harness's own tool name. */
  name?: string;
  /** A regular expression for the call's input, written as JSON. */
  inputMatches?: string;
  flags?: string;
  /** The most lines the call's input may have, counted in its longest string value, found at any depth. */
  inputLinesMax?: number;
  /** The fewest lines the call's input may have, counted in the same way: `inputLinesMin: 1001` fits a call with a value of more than 1000 lines. */
  inputLinesMin?: number;
  /** The fewest milliseconds the call took, from its tool result. A call with no duration does not fit. Needs `toolDurations`. */
  minDurationMs?: number;
  /** The most milliseconds the call took. A call with no duration does not fit. Needs `toolDurations`. */
  maxDurationMs?: number;
  /** Whose calls fit: the main thread, any subagent, or the agents of one type. Absent: every agent. Needs `childCalls`. */
  by?: By;
  /**
   * An agent name: the call must be a `subagent` call that starts that agent, by the rule of `agent_dispatched`: its
   * type, with any plugin prefix dropped, is the name, or, for a dispatch of no type or `general-purpose`, its brief
   * has a first line `name: <agent>`, or, with no `name:` line, holds the name as a whole word in its first 400 characters. Needs `subagents`.
   */
  dispatches?: string;
}

// The keys a matcher takes today, with the definitions of the check fields of the same name.
const KEYS = [
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
];
const SUBJECT_KEYS = ["kind", "name", "inputMatches", "by", "dispatches"];

/** The keys of a matcher that load, each with its definition. The JSON Schema is written from this. */
export const MATCHER_KEYS = Object.fromEntries(
  KEYS.map((key) => [key, FIELDS[key]]),
) as Record<string, FieldDef>;

/**
 * Reads one matcher.
 * @param raw - The parsed value.
 * @param where - Names the file, the check and the key in an error message.
 * @param extras - Keys the matcher takes besides its own, such as `which`, with their definitions. They come back
 *   in the result, read with their types.
 * @returns The matcher, and the extras that were set.
 * @throws {UsageError} For a value that is not an object, a key that is unknown, a value of the wrong type, or a
 *   matcher that names none of `kind`, `name`, `inputMatches` and `by`.
 */
export function parseMatcher(
  raw: unknown,
  where: string,
  extras: Record<string, FieldDef> = {},
): ToolMatcher {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError(`${where}: a matcher must be an object`);
  }
  const given = raw as Record<string, unknown>;
  const defs = { ...MATCHER_KEYS, ...extras };
  const at = { where, owner: "a matcher", siblings: given };
  const unknown = Object.keys(given).find((key) => !Object.hasOwn(defs, key));
  if (unknown !== undefined) {
    throw new UsageError(
      `${where}: unknown key "${unknown}" for a matcher; allowed: ${Object.keys(defs).join(", ")}`,
    );
  }
  const read = Object.fromEntries(
    Object.keys(given).map((key) => [key, readField(defs, key, at)]),
  );
  checkLineBounds(read, where);
  if (!SUBJECT_KEYS.some((key) => key in read)) {
    throw new UsageError(
      `${where}: a matcher needs at least one of ${SUBJECT_KEYS.map((key) => `"${key}"`).join(", ")}`,
    );
  }
  return read;
}

// Reads a list of matchers, each with the extras of the field.
const parseMatchers: FieldParser = (value, at) => {
  const where = `${at.where}.${at.name}`;
  if (!Array.isArray(value) || value.length === 0) {
    throw new UsageError(`${where}: must be a non-empty list of matchers`);
  }
  return value.map((item, position) =>
    parseMatcher(item, `${where}[${String(position)}]`, at.def.extras),
  );
};

registerParser("matcher", (value, at) =>
  parseMatcher(value, `${at.where}.${at.name}`, at.def.extras),
);
registerParser("matchers", parseMatchers);

/** A matcher with the end of the matching calls that counts, for `before` and `after`. */
export type EndMatcher = ToolMatcher & { which?: "first" | "last" };

// The input of each call as JSON, written once however many checks and matchers look at it.
const INPUT_JSON = new WeakMap<ToolCall, string>();
const inputJson = (call: ToolCall): string => {
  let text = INPUT_JSON.get(call);
  if (text === undefined) {
    text = JSON.stringify(call.input ?? null);
    INPUT_JSON.set(call, text);
  }
  return text;
};

/**
 * Compiles a pattern once, for a check that tests many texts. `g` and `y` flags stay legal, so the position is reset
 * before each test.
 * @param pattern - The source of a regular expression; absent for a test that every text passes.
 * @param flags - Its flags.
 * @returns A test of one text.
 */
export const tester = (
  pattern: string | undefined,
  flags: string | undefined,
): ((text: string) => boolean) => {
  if (pattern === undefined) return () => true;
  const expression = regex(pattern, flags);
  return (text) => {
    expression.lastIndex = 0;
    return expression.test(text);
  };
};

/**
 * Tells whether a call's kind fits a matcher's.
 * @param matcher - What the call must be.
 * @param call - A tool call of the run.
 * @returns True when the matcher names no kind or the call's own. For compatibility with 0.0.1, which had no `mcp`
 *   kind, a matcher of kind `other` with no `name` also fits an `mcp` call; one with a `name` does not.
 */
const kindFits = (matcher: ToolMatcher, call: ToolCall): boolean =>
  matcher.kind === undefined ||
  call.kind === matcher.kind ||
  (matcher.kind === "other" &&
    matcher.name === undefined &&
    call.kind === "mcp");

/**
 * Compiles a matcher once, for a check that tests many calls.
 * @param matcher - What a call must be.
 * @returns A test of one call: true when every key the matcher sets fits. The kind is equal, and the patterns,
 *   compiled with the matcher's own flags, find a match in the tool name and in the input written as JSON.
 */
function compileMatcher(matcher: ToolMatcher): (call: ToolCall) => boolean {
  const name = tester(matcher.name, matcher.flags);
  const input = tester(matcher.inputMatches, matcher.flags);
  const { inputLinesMax, inputLinesMin, minDurationMs, maxDurationMs, by } =
    matcher;
  const agent =
    matcher.dispatches === undefined
      ? undefined
      : normalizeAgent(matcher.dispatches);
  const longest = (call: ToolCall): number =>
    countLines(longestString(call.input));
  return (call) =>
    fitsBy(by, call.agent) &&
    (agent === undefined ||
      (call.kind === "subagent" && ruleOf(call, agent) !== null)) &&
    kindFits(matcher, call) &&
    name(call.name) &&
    input(inputJson(call)) &&
    (inputLinesMax === undefined || longest(call) <= inputLinesMax) &&
    (inputLinesMin === undefined || longest(call) >= inputLinesMin) &&
    (minDurationMs === undefined ||
      (call.durationMs !== undefined && call.durationMs >= minDurationMs)) &&
    (maxDurationMs === undefined ||
      (call.durationMs !== undefined && call.durationMs <= maxDurationMs));
}

/**
 * Tells whether a call fits a matcher.
 * @param matcher - What the call must be.
 * @param call - A tool call of the run.
 * @returns True when the call fits every key the matcher sets.
 */
export const matches = (matcher: ToolMatcher, call: ToolCall): boolean =>
  compileMatcher(matcher)(call);

/**
 * Finds the calls that fit a matcher.
 * @param all - Every tool call of the run.
 * @param matcher - What a call must be.
 * @returns The positions of the matching calls, in order.
 */
export function hitsOf(all: ToolCall[], matcher: ToolMatcher): number[] {
  const fits = compileMatcher(matcher);
  return all.flatMap((call, at) => (fits(call) ? [at] : []));
}

/**
 * Finds the first call that no matcher of a list ignores.
 * @param all - Every tool call of the run.
 * @param ignoring - The calls to drop.
 * @returns Its position, or -1 when every call is ignored or there is none.
 */
export function firstOutside(all: ToolCall[], ignoring: ToolMatcher[]): number {
  const skipped = ignoring.map(compileMatcher);
  return all.findIndex((call) => !skipped.some((fits) => fits(call)));
}

/**
 * Writes a matcher the way a reason names it.
 * @param matcher - Any matcher, or the matcher keys of a check.
 * @returns The keys it sets, as JSON.
 */
export const describeMatcher = (matcher: ToolMatcher): string =>
  JSON.stringify(
    Object.fromEntries(
      KEYS.filter((key) => key in matcher).map((key) => [
        key,
        matcher[key as keyof ToolMatcher],
      ]),
    ),
  );

const INPUT_WIDTH = 80;
const NEIGHBOURS = 1;

const ID_TAIL = 6;
// The agent's type, and the tail of its id when it is not the main thread, so two agents of one type tell apart.
const agentWords = ({ agent }: ToolCall): string =>
  agent === undefined || agent.id === "main"
    ? "main"
    : `${agent.type}@${agent.id.slice(-ID_TAIL)}`;

// One line of a quote: `#<index> t<turn> <agent type> <kind> <name> <first 80 chars of the input as JSON>`.
const quoteLine = (call: ToolCall, position: number): string =>
  [
    `#${String(call.index ?? position)}`,
    `t${call.turn === undefined ? "?" : String(call.turn)}`,
    agentWords(call),
    call.kind,
    call.name,
    JSON.stringify(call.input ?? null).slice(0, INPUT_WIDTH),
  ].join(" ");

/**
 * Names a call the way a reason quotes it, by its place in the whole run. In a turn's slice a call's position is its
 * place among that turn's calls, but its `index` is its place in the run, which `show` and the quoted lines use.
 * @param calls - The calls a check looks at.
 * @param position - A position in `calls`.
 * @returns The call's own `index` when it has one, else the position, as text.
 */
export const callNo = (calls: ToolCall[], position: number): string =>
  String(calls[position]?.index ?? position);

/**
 * Quotes the part of a run's call list that a reason is about.
 * @param calls - Every tool call of the run, in order.
 * @param around - The positions in `calls` that matter. Each is quoted with the call before it and the call after it.
 *   None: the list from its start.
 * @param limit - The most calls to quote. Default: 12.
 * @returns One line per call, and a last line that counts the calls it left out; "(no tool calls)" for an empty list.
 */
export function quoteCalls(
  calls: ToolCall[],
  around: number[],
  limit = 12,
): string {
  if (calls.length === 0) return "(no tool calls)";
  const wanted =
    around.length === 0
      ? calls.map((_, position) => position)
      : [
          ...new Set(
            around.flatMap((at) =>
              [at - NEIGHBOURS, at, at + NEIGHBOURS].filter(
                (position) => position >= 0 && position < calls.length,
              ),
            ),
          ),
        ].sort((a, b) => a - b);
  const lines = wanted
    .slice(0, limit)
    .map((position) => quoteLine(calls[position] as ToolCall, position));
  const left = wanted.length - lines.length;
  return (left > 0 ? [...lines, `... ${String(left)} more`] : lines).join("\n");
}
