import type { Spec } from "./index.js";
import type { FieldDefault } from "./field-default.js";
import type { FieldAt, FieldDef } from "./fields.js";
import { FIELDS, WEIGHT, readField } from "./fields.js";

export { minOf } from "./min-of.js";

type Fields = Record<string, unknown>;

/**
 * Reads one default of a field table.
 * @param def - The field's definition.
 * @param type - The check type.
 * @param check - The fields the check sets, for a default that depends on them.
 * @returns The default of that type, else the one of `*`; undefined when the field has none for the check.
 */
function defaultIn(
  def: FieldDef | undefined,
  type: string,
  check: Fields,
): unknown {
  const table = def?.default?.value;
  if (table === undefined) return undefined;
  const found = Object.hasOwn(table, type) ? table[type] : table["*"];
  return typeof found === "function"
    ? (found as (fields: Fields) => unknown)(check)
    : found;
}

/**
 * Reads a field of a check as a rule must: the check's own value, else the default of its type.
 * @param check - The check, which names its type.
 * @param check.type - The type, which picks the default in a table that has one for each type.
 * @param field - The field's name in `FIELDS`.
 * @returns The value; undefined when the check leaves it out and the field has no default for the type.
 */
export function valueOf(check: { type: string }, field: string): unknown {
  const own = (check as Fields)[field];
  return own === undefined ? defaultIn(FIELDS[field], check.type, check) : own;
}

/**
 * Writes the defaults of a field table into one matcher or a list of them.
 * @param value - The matcher, a list of matchers, or anything else, which is returned as it is.
 * @param extras - The extra keys the field's matchers take, with their definitions.
 * @returns The matchers with each extra key that has a default set.
 */
function matchersFilled(
  value: unknown,
  extras: Record<string, FieldDef> | undefined,
): unknown {
  if (extras === undefined) return value;
  if (Array.isArray(value))
    return value.map((one) => matchersFilled(one, extras));
  if (value === null || typeof value !== "object") return value;
  const filled: Fields = { ...(value as Fields) };
  for (const [key, def] of Object.entries(extras)) {
    filled[key] ??= defaultIn(def, "*", filled);
  }
  return filled;
}

/**
 * Writes out every default that the rules of a check apply, so that a reader sees what a run will do.
 * @param check - Any check of a loaded case.
 * @param spec - The check type's entry of `CHECKS`.
 * @returns The check with each field it leaves out set to the default of its type, in `FIELDS`; the fields its type
 *   fixes (`implied`); and the defaults inside its `before` and `after` matchers. A field that its check does not
 *   take, or that has no default for the check, is not added. A field the check sets is kept.
 */
export function withDefaults<Check extends { type: string }>(
  check: Check,
  spec: Spec | undefined,
): Check {
  const set: Fields = { ...check };
  const names = [
    ...(spec?.fields ?? []),
    ...(spec?.optional ?? []),
    "ifUnsupported",
  ];
  const filled: Fields = { ...(spec?.implied ?? {}), ...set };
  for (const name of names) {
    filled[name] ??= defaultIn(FIELDS[name], check.type, filled);
  }
  for (const [name, value] of Object.entries(filled)) {
    filled[name] = matchersFilled(value, FIELDS[name]?.extras);
  }
  return Object.fromEntries(
    Object.entries(filled).filter(([, value]) => value !== undefined),
  ) as unknown as Check;
}

/**
 * Words a default for the docs.
 * @param default_ - The field's default.
 * @returns The value as the check file writes it, with the check types it applies to when they differ, and the note.
 */
export function describeDefault(default_: FieldDefault): string {
  const entries = Object.entries(default_.value).map(([type, value]) => {
    const shown =
      typeof value === "function"
        ? (value as (f: Fields) => unknown)({})
        : value;
    return [type, `\`${JSON.stringify(shown)}\``] as const;
  });
  const [only] = entries;
  const text =
    entries.length === 1 && only?.[0] === "*"
      ? only[1]
      : entries.map(([type, shown]) => `${shown} for \`${type}\``).join(", ");
  return default_.note === undefined ? text : `${text}; ${default_.note}`;
}

/**
 * Reads the `weight` of a check.
 * @param record - The check as written.
 * @param type - The check's type.
 * @param at - Where the check is, for an error message.
 * @returns The weight; its default (1) when it is absent or null, which counts as none.
 * @throws {UsageError} When the weight is not a positive number.
 */
export function weightOf(record: Fields, type: string, at: FieldAt): unknown {
  const given = record["weight"];
  return given === undefined || given === null
    ? defaultIn(WEIGHT, type, {})
    : readField({ weight: WEIGHT }, "weight", at);
}
