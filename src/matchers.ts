import type { FieldDef, FieldParser } from "./checks/fields.js";
import { FIELDS, readField, registerParser } from "./checks/fields.js";
import { regex } from "./checks/rules.js";
import type { ToolCall, ToolKind } from "./harnesses/shared.js";
import { UsageError } from "./scope.js";

/** Who made a call. The shape lands with subagent attribution; until then no matcher may name it. */
type By = Record<string, unknown>;

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
  /** Not yet supported: a load error. */
  inputLinesMax?: number;
  /** Not yet supported: a load error. */
  by?: By;
}

// The keys a matcher takes today, with the definitions of the check fields of the same name.
const KEYS = ["kind", "name", "inputMatches", "flags"];
// The keys of the matcher shape that no check can use yet.
const NOT_YET = ["by", "inputLinesMax"];
const SUBJECT_KEYS = ["kind", "name", "inputMatches"];

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
 * @throws {UsageError} For a value that is not an object, a key that is unknown or not yet supported, a value of the
 *   wrong type, or a matcher that names none of `kind`, `name` and `inputMatches`.
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
  const unsupported = NOT_YET.find((key) => key in given);
  if (unsupported) {
    throw new UsageError(`${where}: "${unsupported}" is not yet supported`);
  }
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

/**
 * Tells whether a call fits a matcher.
 * @param matcher - What the call must be.
 * @param call - A tool call of the run.
 * @returns True when every key the matcher sets fits: the kind is equal, and the patterns, compiled with the
 *   matcher's own flags, find a match in the tool name and in the input written as JSON.
 */
export const matches = (matcher: ToolMatcher, call: ToolCall): boolean =>
  (matcher.kind === undefined || call.kind === matcher.kind) &&
  (matcher.name === undefined ||
    regex(matcher.name, matcher.flags).test(call.name)) &&
  (matcher.inputMatches === undefined ||
    regex(matcher.inputMatches, matcher.flags).test(
      JSON.stringify(call.input ?? null),
    ));

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

// One line of a quote: `#<index> t<turn> <agent type> <kind> <name> <first 80 chars of the input as JSON>`.
const quoteLine = (call: ToolCall, position: number): string =>
  [
    `#${String(call.index ?? position)}`,
    `t${call.turn === undefined ? "?" : String(call.turn)}`,
    call.agent?.type ?? "main",
    call.kind,
    call.name,
    JSON.stringify(call.input ?? null).slice(0, INPUT_WIDTH),
  ].join(" ");

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
