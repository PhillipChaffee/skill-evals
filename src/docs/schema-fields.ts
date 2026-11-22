import { NEED_PATTERN } from "../capabilities.js";
import type { FieldDef } from "../checks/fields.js";
import { SLUG_PATTERN } from "../checks/fields.js";
import { CASE_ENV_PATTERN } from "../env.js";
import { HARNESSES } from "../harnesses/index.js";
import { TOOL_KINDS } from "../harnesses/shared.js";
import { MATCHER_KEYS } from "../matchers.js";
import { BY_SCHEMA, STEPS_SCHEMA } from "./schema-values.js";

/** A JSON Schema, or a part of one. */
export type Schema = Record<string, unknown>;

export const X_KEYS = { "^x-": {} };
export const PLAIN_TEXT = { type: "string", minLength: 1 };
// A path inside the workspace: not absolute, and no `..` step.
const INSIDE_WORKSPACE = String.raw`^(?![\\/])(?!(.*[\\/])?\.\.([\\/]|$)).+$`;

/** The schema of each field type that is a plain value. Every other type is built in `valueSchema`. */
const BY_TYPE: Partial<Record<FieldDef["type"], Schema>> = {
  text: PLAIN_TEXT,
  regex: PLAIN_TEXT,
  flags: PLAIN_TEXT,
  glob: PLAIN_TEXT,
  path: { ...PLAIN_TEXT, pattern: INSIDE_WORKSPACE },
  kind: { type: "string", enum: TOOL_KINDS },
  int: { type: "integer", minimum: 1 },
  count: { type: "integer", minimum: 0 },
  unit: { type: "number", minimum: 0, maximum: 1 },
  signed: { type: "number", minimum: -1, maximum: 1 },
  // A null weight counts as none: the loader has always accepted it.
  number: {
    anyOf: [{ type: "number", exclusiveMinimum: 0 }, { type: "null" }],
  },
  answers: {
    type: "object",
    minProperties: 2,
    additionalProperties: { type: "number", minimum: 0, maximum: 1 },
  },
  harnesses: {
    type: "array",
    minItems: 1,
    items: { enum: HARNESSES.map(({ id }) => id) },
  },
  bool: { type: "boolean" },
  slug: { type: "string", pattern: SLUG_PATTERN },
  tags: { type: "array", items: { type: "string", pattern: SLUG_PATTERN } },
  texts: { type: "array", minItems: 1, items: PLAIN_TEXT },
  rubric: {
    anyOf: [
      PLAIN_TEXT,
      {
        type: "object",
        properties: { pass: PLAIN_TEXT, fail: PLAIN_TEXT },
        required: ["pass", "fail"],
        additionalProperties: false,
      },
    ],
  },
  needs: { type: "array", items: { type: "string", pattern: NEED_PATTERN } },
  steps: STEPS_SCHEMA,
  envvars: {
    type: "object",
    patternProperties: {
      [CASE_ENV_PATTERN]: { type: "string", pattern: "^[^\\u0000]*$" },
    },
    additionalProperties: false,
  },
  by: BY_SCHEMA,
  object: { type: "object" },
};

/**
 * Makes the schema of a matcher.
 * @param extras - The keys of the field besides the matcher keys.
 * @returns A strict object with the keys a matcher loads with, and at least one of `kind`, `name`, `inputMatches`, `by` and `dispatches`.
 */
function matcherSchema(extras: Record<string, FieldDef> = {}): Schema {
  return {
    type: "object",
    properties: propertiesOf({ ...MATCHER_KEYS, ...extras }),
    anyOf: ["kind", "name", "inputMatches", "by", "dispatches"].map((key) => ({
      required: [key],
    })),
    additionalProperties: false,
  };
}

/**
 * Makes the schema of a transcript scope.
 * @returns A word, or an object with exactly one of `before` and `after`, or `first_message: true` with `before`.
 */
function scopeSchema(): Schema {
  const matcher = matcherSchema();
  const strict = (properties: Schema, required: string[]): Schema => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  return {
    anyOf: [
      { type: "string", enum: ["first_message", "final_message", "any"] },
      strict({ before: matcher }, ["before"]),
      strict({ after: matcher }, ["after"]),
      strict({ first_message: { const: true }, before: matcher }, [
        "first_message",
        "before",
      ]),
    ],
  };
}

/** The types whose schema is built from the field's own definition, not taken from `BY_TYPE`. */
const BUILT: Partial<Record<FieldDef["type"], (def: FieldDef) => Schema>> = {
  enum: (def) => ({ type: "string", enum: def.values }),
  vias: (def) => ({
    anyOf: [
      { type: "string", enum: def.values },
      {
        type: "array",
        minItems: 1,
        items: { type: "string", enum: def.values },
      },
    ],
  }),
  scope: () => scopeSchema(),
  matcher: (def) => matcherSchema(def.extras),
  matchers: (def) => ({
    type: "array",
    minItems: 1,
    items: matcherSchema(def.extras),
  }),
  // A list of words, when the field names the words it allows.
  texts: (def) =>
    def.values
      ? { type: "array", minItems: 1, items: { enum: def.values } }
      : (BY_TYPE.texts ?? {}),
};

/**
 * Makes the schema of one field.
 * @param name - The field's key.
 * @param def - The field's entry in its table.
 * @returns The type's schema, with the key as its title and the table's sentence as its description.
 */
export function valueSchema(name: string, def: FieldDef): Schema {
  const base = BUILT[def.type]?.(def) ?? BY_TYPE[def.type] ?? {};
  return { title: name, description: def.meaning, ...base };
}

/**
 * Makes the schema of a table of keys.
 * @param defs - The table.
 * @param skip - Keys to leave out because the caller writes them.
 * @returns A `properties` object, with the schema of each key.
 */
export const propertiesOf = (
  defs: Record<string, FieldDef>,
  skip: string[] = [],
) =>
  Object.fromEntries(
    Object.entries(defs)
      .filter(([name]) => !skip.includes(name))
      .map(([name, def]) => [name, valueSchema(name, def)]),
  );
