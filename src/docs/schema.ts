import { NEED_PATTERN } from "../capabilities.js";
import { CASE_KEYS } from "../cases.js";
import type { FieldDef } from "../checks/fields.js";
import { FIELDS, SLUG_PATTERN, WEIGHT } from "../checks/fields.js";
import { CHECKS } from "../checks/index.js";
import { CASE_ENV_PATTERN, ENV_NAME_PATTERN } from "../env.js";
import { HARNESSES } from "../harnesses/index.js";
import { MATCHER_KEYS } from "../matchers.js";
import { TOOL_KINDS } from "../harnesses/shared.js";
import { CONFIG_FILE, CONFIG_KEYS } from "../project.js";
import { SCHEMA_KEY } from "../schema-key.js";
import { VARIANT_KEYS } from "../variants.js";
import { configMeaning } from "./reference.js";

// The JSON Schemas of the case file and of the config file, written from the tables the loaders read: CASE_KEYS,
// FIELDS, CHECKS, VARIANT_KEYS and CONFIG_KEYS. They use these keywords and no others, and the validator in
// schema.test.ts supports exactly them: $schema, $id, $defs, $ref, title, description, type, const, enum,
// properties, patternProperties, additionalProperties, required, dependentRequired, minProperties, items, minItems,
// minLength, minimum, maximum, exclusiveMinimum, pattern, oneOf and anyOf.
//
// What the schemas cannot say, because it depends on more than one value or on a file: a decision check takes
// exactly one of `expect` and `options` (the check's description says so); an `options` answer needs a name; a
// variant's `promptAppend` needs a `prompt.md` with text beside the case file; a variant id is unique within its case;
// a case needs a prompt source, which is `prompt.md` or a `prompt` in every variant; a regular expression must compile;
// and the ids of a case's directories may not hold `@` or `,`. The loader still checks all of these.
//
// Where the schemas are looser than the loader: a `prompt` or `promptAppend` of only whitespace, a `flags` text that
// is not valid flags, a `git` setup step with `branch` and `"init": false`, a regular expression that does not compile, a repeated variant id, an `options` answer with
// an empty name, a `tool_order` that gives `sequence` with one of `before` and `after`, and a `min` above `max`, pass the schema and fail to load.

/** A JSON Schema, or a part of one. */
type Schema = Record<string, unknown>;

/** The folder that the schemas' `$id` values are under: where the docs site is served. */
const SCHEMA_BASE = "https://phillipchaffee.github.io/skill-evals/schema/";
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const X_KEYS = { "^x-": {} };
const PLAIN_TEXT = { type: "string", minLength: 1 };
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
  needs: { type: "array", items: { type: "string", pattern: NEED_PATTERN } },
  steps: {
    type: "array",
    minItems: 1,
    items: {
      oneOf: [
        {
          type: "object",
          required: ["run"],
          properties: {
            run: PLAIN_TEXT,
            timeoutSeconds: { type: "integer", minimum: 1 },
          },
          additionalProperties: false,
        },
        {
          type: "object",
          required: ["git"],
          properties: {
            git: {
              type: "object",
              minProperties: 1,
              // The loader also needs `init` to be true; the schema cannot say that.
              dependentRequired: { branch: ["init"] },
              properties: {
                init: { type: "boolean" },
                branch: {
                  type: "string",
                  pattern: "^[A-Za-z0-9_][A-Za-z0-9._/-]*$",
                },
                commitAll: PLAIN_TEXT,
                remote: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      ],
    },
  },
  envvars: {
    type: "object",
    patternProperties: {
      [CASE_ENV_PATTERN]: { type: "string", pattern: "^[^\\u0000]*$" },
    },
    additionalProperties: false,
  },
  object: { type: "object" },
};

/**
 * Makes the schema of a matcher.
 * @param extras - The keys of the field besides the matcher keys.
 * @returns A strict object with the keys a matcher loads with, and at least one of `kind`, `name` and `inputMatches`.
 *   `by` is left out, because the loader rejects it.
 */
function matcherSchema(extras: Record<string, FieldDef> = {}): Schema {
  return {
    type: "object",
    properties: propertiesOf({ ...MATCHER_KEYS, ...extras }),
    anyOf: ["kind", "name", "inputMatches"].map((key) => ({ required: [key] })),
    additionalProperties: false,
  };
}

/**
 * Makes the schema of one field.
 * @param name - The field's key.
 * @param def - The field's entry in its table.
 * @returns The type's schema, with the key as its title and the table's sentence as its description.
 */
function valueSchema(name: string, def: FieldDef): Schema {
  const base: Schema =
    def.type === "enum"
      ? { type: "string", enum: def.values }
      : def.type === "vias"
        ? {
            anyOf: [
              { type: "string", enum: def.values },
              {
                type: "array",
                minItems: 1,
                items: { type: "string", enum: def.values },
              },
            ],
          }
        : def.type === "matcher"
          ? matcherSchema(def.extras)
          : def.type === "matchers"
            ? { type: "array", minItems: 1, items: matcherSchema(def.extras) }
            : (BY_TYPE[def.type] ?? {});
  return { title: name, description: def.meaning, ...base };
}

/**
 * Makes the schema of a table of keys.
 * @param defs - The table.
 * @param skip - Keys to leave out because the caller writes them.
 * @returns A `properties` object, with the schema of each key.
 */
const propertiesOf = (defs: Record<string, FieldDef>, skip: string[] = []) =>
  Object.fromEntries(
    Object.entries(defs)
      .filter(([name]) => !skip.includes(name))
      .map(([name, def]) => [name, valueSchema(name, def)]),
  );

/**
 * Makes the schema of one check type.
 * @param type - The type's key in `CHECKS`.
 * @returns An object that requires the type's `type` and fields, allows its optional fields and `x-` keys, and
 *   nothing else. A type with `oneOf` fields needs at least one of them.
 * @throws {Error} When a field of the spec has no entry in `FIELDS`.
 */
function checkSchema(type: string): Schema {
  const spec = CHECKS[type];
  const fields = [
    ...(spec?.fields ?? []),
    ...(spec?.optional ?? []),
    ...(spec?.oneOf ?? []),
    ...(spec?.forms?.flat() ?? []),
  ];
  const named = Object.fromEntries(
    [...new Set([...fields, "requires", "ifUnsupported"])].map((field) => {
      const def = FIELDS[field];
      if (!def)
        throw new Error(`check ${type}: field ${field} is not in FIELDS`);
      return [field, valueSchema(field, def)];
    }),
  );
  return {
    title: type,
    description: [spec?.scores, spec?.note].filter(Boolean).join(" "),
    type: "object",
    required: ["type", ...(spec?.fields ?? [])],
    properties: {
      type: { const: type },
      weight: valueSchema("weight", WEIGHT),
      ...named,
    },
    ...(spec?.oneOf && {
      anyOf: spec.oneOf.map((field) => ({ required: [field] })),
    }),
    ...(spec?.together && { dependentRequired: spec.together }),
    ...(spec?.forms && {
      oneOf: spec.forms.map((form) => ({ required: form })),
    }),
    patternProperties: X_KEYS,
    additionalProperties: false,
  };
}

/**
 * Makes the schema of a variant.
 * @returns An object that requires `id` and exactly one of `prompt` and `promptAppend`, and allows the other keys of the table and `x-` keys.
 */
const variantSchema = (): Schema => ({
  title: "variant",
  description:
    "The same case put differently. It runs as `<case id>@<variant id>`.",
  type: "object",
  required: ["id"],
  properties: propertiesOf(VARIANT_KEYS),
  oneOf: [{ required: ["prompt"] }, { required: ["promptAppend"] }],
  patternProperties: X_KEYS,
  additionalProperties: false,
});

const checkName = (type: string): string => `check-${type}`;

/**
 * Makes the JSON Schema of `case.json`.
 * @returns A 2020-12 schema. Each check type is a definition, and `checks` takes a list of them told apart by `type`.
 */
export function caseSchema(): Schema {
  return {
    $schema: DRAFT,
    $id: `${SCHEMA_BASE}case.schema.json`,
    title: "skill-evals case",
    description:
      "The case.json of a skill-evals case: the checks that a run of its prompt must pass.",
    type: "object",
    required: ["checks"],
    properties: {
      [SCHEMA_KEY]: {
        type: "string",
        description: "The address of this schema, for editors.",
      },
      ...propertiesOf(CASE_KEYS, ["checks", "variants"]),
      checks: {
        title: "checks",
        description: CASE_KEYS["checks"]?.meaning,
        type: "array",
        minItems: 1,
        items: {
          oneOf: Object.keys(CHECKS).map((type) => ({
            $ref: `#/$defs/${checkName(type)}`,
          })),
        },
      },
      variants: {
        title: "variants",
        description: CASE_KEYS["variants"]?.meaning,
        type: "array",
        minItems: 1,
        items: { $ref: "#/$defs/variant" },
      },
    },
    dependentRequired: { harnesses: ["note"] },
    patternProperties: X_KEYS,
    additionalProperties: false,
    $defs: {
      variant: variantSchema(),
      ...Object.fromEntries(
        Object.keys(CHECKS).map((type) => [checkName(type), checkSchema(type)]),
      ),
    },
  };
}

/**
 * Makes the JSON Schema of the config file.
 * @returns A 2020-12 schema with one property for each key of `CONFIG_KEYS`, and no other key allowed.
 */
export function configSchema(): Schema {
  const byType: Record<string, Schema> = {
    string: { type: "string" },
    number: { type: "number" },
    boolean: { type: "boolean" },
    "string[]": { type: "array", items: { type: "string", minLength: 1 } },
  };
  return {
    $schema: DRAFT,
    $id: `${SCHEMA_BASE}config.schema.json`,
    title: "skill-evals config",
    description: `The ${CONFIG_FILE} of a project: defaults for the options of the commands.`,
    type: "object",
    properties: {
      [SCHEMA_KEY]: {
        type: "string",
        description: "The address of this schema, for editors.",
      },
      ...Object.fromEntries(
        Object.entries(CONFIG_KEYS).map(([key, type]) => [
          key,
          {
            title: key,
            description: configMeaning(key),
            ...byType[type],
            ...(key === "env" && {
              items: { type: "string", pattern: ENV_NAME_PATTERN },
            }),
          },
        ]),
      ),
    },
    additionalProperties: false,
  };
}

/** One schema file of the package. */
export interface SchemaFile {
  /** Where it is, relative to the repository root. */
  file: string;
  schema: Schema;
}

/**
 * Lists the schema files that the package ships.
 * @returns The case schema and the config schema, with their paths.
 */
export const schemaFiles = (): SchemaFile[] => [
  { file: "schema/case.schema.json", schema: caseSchema() },
  { file: "schema/config.schema.json", schema: configSchema() },
];
