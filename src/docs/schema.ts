import { CASE_KEYS } from "../cases.js";
import type { FieldDef } from "../checks/fields.js";
import { FIELDS, WEIGHT } from "../checks/fields.js";
import { CHECKS } from "../checks/index.js";
import { ENV_NAME_PATTERN } from "../env.js";
import { CONFIG_FILE, CONFIG_KEYS, MAX_SEED } from "../project.js";
import { FORMATS } from "../report/formats.js";
import { SCHEMA_KEY } from "../schema-key.js";
import { LIFECYCLE_EVENTS, TURN_KEYS } from "../turn-spec.js";
import { VARIANT_KEYS } from "../variants.js";
import { configMeaning } from "./reference.js";
import type { Schema } from "./schema-fields.js";
import {
  PLAIN_TEXT,
  X_KEYS,
  propertiesOf,
  valueSchema,
} from "./schema-fields.js";

// The JSON Schemas of the case file and of the config file, written from the tables the loaders read: CASE_KEYS,
// FIELDS, CHECKS, VARIANT_KEYS and CONFIG_KEYS. They use these keywords and no others, and the validator in
// schema.test.ts supports exactly them: $schema, $id, $defs, $ref, title, description, type, const, enum,
// properties, patternProperties, additionalProperties, required, dependentRequired, minProperties, items, minItems,
// minLength, minimum, maximum, exclusiveMinimum, pattern, oneOf and anyOf.
//
// What the schemas cannot say, because it depends on more than one value or on a file: a decision check takes
// exactly one of `expect` and `options` (the check's description says so); an `options` answer needs a name; a
// variant's `promptAppend` needs a `prompt.md` with text beside the case file; a case has `prompt.md` or `turns`, not
// both, and the first turn may not be an event; a turn's `prompt` names a file of the case that must exist; a variant id is unique within its case;
// a case needs at least one check, in `checks` or in a turn (the schema leaves `checks` optional); a case needs a prompt source, which is `prompt.md` or a `prompt` in every variant; a regular expression must compile;
// and the ids of a case's directories may not hold `@` or `,`. The loader still checks all of these.
//
// Where the schemas are looser than the loader: a `prompt` or `promptAppend` of only whitespace, a `flags` text that
// is not valid flags, a `git` setup step with `branch` and `"init": false`, a regular expression that does not compile, a repeated variant id, an `options` answer with
// an empty name, a `tool_order` that gives `sequence` with one of `before` and `after`, and a `min` above `max`, pass the schema and fail to load.

/** The folder that the schemas' `$id` values are under: where the docs site is served. */
const SCHEMA_BASE = "https://phillipchaffee.github.io/skill-evals/schema/";
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
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
 * Makes the schema of the `turns` list of a case or a variant.
 * @param meaning - What the key holds, for its description.
 * @returns A non-empty list of turns.
 */
const turnsSchema = (meaning: string | undefined): Schema => ({
  title: "turns",
  description: meaning,
  type: "array",
  minItems: 1,
  items: { $ref: "#/$defs/turn" },
});

/**
 * Makes the schema of a turn.
 * @returns An object with exactly one of `prompt`, `invoke`, `reply` and `event`, and optional `checks`, which may be any check
 *   but `judge` and `decision`; `x-` keys are allowed, and nothing else.
 */
const turnSchema = (): Schema => ({
  title: "turn",
  description:
    "One step of a case with turns: a user message, a user invocation of a skill, a conditional reply to a question, or a lifecycle event.",
  type: "object",
  properties: {
    prompt: valueSchema("prompt", TURN_KEYS["prompt"] as FieldDef),
    invoke: {
      title: "invoke",
      description: TURN_KEYS["invoke"]?.meaning,
      type: "object",
      required: ["skill"],
      properties: { skill: PLAIN_TEXT, args: PLAIN_TEXT },
      patternProperties: X_KEYS,
      additionalProperties: false,
    },
    reply: {
      title: "reply",
      description: TURN_KEYS["reply"]?.meaning,
      type: "object",
      required: ["whenAsked", "prompt"],
      properties: {
        whenAsked: { title: "whenAsked", type: "string", minLength: 1 },
        prompt: PLAIN_TEXT,
      },
      patternProperties: X_KEYS,
      additionalProperties: false,
    },
    event: {
      title: "event",
      description: TURN_KEYS["event"]?.meaning,
      type: "string",
      enum: LIFECYCLE_EVENTS,
    },
    checks: {
      title: "checks",
      description: TURN_KEYS["checks"]?.meaning,
      type: "array",
      minItems: 1,
      items: {
        oneOf: Object.keys(CHECKS)
          .filter((type) => type !== "judge" && type !== "decision")
          .map((type) => ({ $ref: `#/$defs/${checkName(type)}` })),
      },
    },
  },
  oneOf: [
    { required: ["prompt"] },
    { required: ["invoke"] },
    { required: ["reply"] },
    { required: ["event"] },
  ],
  patternProperties: X_KEYS,
  additionalProperties: false,
});

/**
 * Makes the schema of a variant.
 * @returns An object that requires `id` and exactly one of `prompt`, `promptAppend` and `turns`, and allows the other keys of the table and `x-` keys.
 */
const variantSchema = (): Schema => ({
  title: "variant",
  description:
    "The same case put differently. It runs as `<case id>@<variant id>`.",
  type: "object",
  required: ["id"],
  properties: {
    ...propertiesOf(VARIANT_KEYS, ["turns"]),
    turns: turnsSchema(VARIANT_KEYS["turns"]?.meaning),
  },
  oneOf: [
    { required: ["prompt"] },
    { required: ["promptAppend"] },
    { required: ["turns"] },
  ],
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
    properties: {
      [SCHEMA_KEY]: {
        type: "string",
        description: "The address of this schema, for editors.",
      },
      ...propertiesOf(CASE_KEYS, ["checks", "variants", "turns"]),
      turns: turnsSchema(CASE_KEYS["turns"]?.meaning),
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
    // Checks may all be in the turns, which the loader checks for.
    anyOf: [
      { required: ["checks"] },
      { required: ["turns"] },
      { required: ["variants"] },
    ],
    dependentRequired: { harnesses: ["note"] },
    patternProperties: X_KEYS,
    additionalProperties: false,
    $defs: {
      variant: variantSchema(),
      turn: turnSchema(),
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
            ...((key === "maxJudgedWeightShare" || key === "maxInvalid") && {
              minimum: 0,
              maximum: 1,
            }),
            ...(key === "minDelta" && { minimum: -1, maximum: 1 }),
            ...(key === "seed" && {
              type: "integer",
              minimum: 1,
              maximum: MAX_SEED,
            }),
            ...(key === "report" && {
              minItems: 1,
              items: { enum: Object.keys(FORMATS) },
            }),
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
