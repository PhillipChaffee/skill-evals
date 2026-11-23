import { isObject } from "../scope.js";

export type Json = Record<string, unknown>;

// "#/$defs/name" split at slashes: the first two parts say where to look.
const REF_PREFIX = 2;
// Every keyword that this validator knows, which are the ones the schemas use. A schema that uses another one throws.
const NOTES = ["$schema", "$id", "$defs", "title", "description"];
const KEYWORDS = new Set([
  ...NOTES,
  ...`$ref type const enum properties patternProperties additionalProperties required dependentRequired minProperties
    items minItems minLength minimum maximum exclusiveMinimum pattern oneOf anyOf`.split(
    /\s+/,
  ),
]);
const TYPES: Record<string, (value: unknown) => boolean> = {
  object: isObject,
  array: Array.isArray,
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  integer: Number.isInteger,
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
};
const num = (schema: Json, key: string): number | undefined =>
  schema[key] as number | undefined;

/**
 * Checks `type`, `const` and `enum`.
 * @param value - The JSON value.
 * @param schema - The schema, or a part of it.
 * @returns The problems found.
 */
function shape(value: unknown, schema: Json): string[] {
  const { type, enum: words } = schema as { type?: string; enum?: unknown[] };
  const out: string[] = [];
  if (type && !TYPES[type]?.(value)) out.push(`not ${type}`);
  if ("const" in schema && value !== schema["const"])
    out.push("not the constant");
  if (words && !words.includes(value)) out.push("not one of the words");
  return out;
}

/**
 * Checks the keywords of a number.
 * @param value - The number.
 * @param schema - The schema, or a part of it.
 * @returns The problems found.
 */
function bounds(value: number, schema: Json): string[] {
  const [low, high, above] = ["minimum", "maximum", "exclusiveMinimum"].map(
    (key) => num(schema, key),
  );
  return [
    ...(low !== undefined && value < low ? ["breaks minimum"] : []),
    ...(high !== undefined && value > high ? ["breaks maximum"] : []),
    ...(above !== undefined && value <= above
      ? ["breaks exclusiveMinimum"]
      : []),
  ];
}

/**
 * Checks the keywords of a number and of a string.
 * @param value - The JSON value.
 * @param schema - The schema, or a part of it.
 * @returns The problems found.
 */
function scalar(value: unknown, schema: Json): string[] {
  const out = shape(value, schema);
  if (typeof value === "number") out.push(...bounds(value, schema));
  if (typeof value === "string") {
    if (value.length < (num(schema, "minLength") ?? 0)) out.push("too short");
    const pattern = schema["pattern"] as string | undefined;
    if (pattern && !new RegExp(pattern).test(value))
      out.push(`does not match ${pattern}`);
  }
  return out;
}

/**
 * Validates a value against the subset of JSON Schema that the package's schemas use.
 * @param value - The JSON value.
 * @param schema - The schema, or a part of it.
 * @param top - The whole schema, which `$ref` resolves in.
 * @returns The problems found, empty when the value is valid.
 * @throws {Error} For a keyword outside the subset, so a schema cannot grow past what this checks.
 */
export function validate(value: unknown, schema: Json, top: Json): string[] {
  const unknown = Object.keys(schema).find((key) => !KEYWORDS.has(key));
  if (unknown) throw new Error(`the validator does not support "${unknown}"`);
  if (typeof schema["$ref"] === "string") {
    const path = schema["$ref"].split("/").slice(REF_PREFIX);
    const target = path.reduce((at, key) => (at as Json)[key], top["$defs"]);
    return validate(value, target as Json, top);
  }
  const out = scalar(value, schema);
  if (Array.isArray(value)) {
    if (value.length < (num(schema, "minItems") ?? 0))
      out.push("too few items");
    const items = schema["items"] as Json | undefined;
    for (const [at, item] of value.entries()) {
      if (items)
        out.push(
          ...validate(item, items, top).map((p) => `[${String(at)}] ${p}`),
        );
    }
  }
  if (isObject(value)) out.push(...members(value, schema, top));
  const matching = (key: string) =>
    (schema[key] as Json[]).filter(
      (part) => validate(value, part, top).length === 0,
    ).length;
  if (schema["oneOf"] && matching("oneOf") !== 1)
    out.push("does not match exactly one of oneOf");
  if (schema["anyOf"] && matching("anyOf") === 0)
    out.push("does not match any of anyOf");
  return out;
}

/**
 * Validates the keywords that apply to an object.
 * @param obj - The object whose keys are checked.
 * @param schema - The schema whose keywords apply.
 * @param top - The whole schema.
 * @returns The problems found.
 */
function members(obj: Json, schema: Json, top: Json): string[] {
  const keys = Object.keys(obj);
  const props = (schema["properties"] ?? {}) as Record<string, Json>;
  const patterns = Object.entries(
    (schema["patternProperties"] ?? {}) as Record<string, Json>,
  );
  const out = ((schema["required"] ?? []) as string[])
    .filter((key) => !keys.includes(key))
    .map((key) => `missing ${key}`);
  for (const [key, needs] of Object.entries(
    (schema["dependentRequired"] ?? {}) as Record<string, string[]>,
  )) {
    if (key in obj)
      out.push(
        ...needs
          .filter((need) => !(need in obj))
          .map((need) => `${key} needs ${need}`),
      );
  }
  if (keys.length < (num(schema, "minProperties") ?? 0))
    out.push("too few properties");
  const extra = schema["additionalProperties"];
  for (const key of keys) {
    const own = key in props ? [props[key] as Json] : [];
    const rules = [
      ...own,
      ...patterns
        .filter(([pattern]) => new RegExp(pattern).test(key))
        .map(([, rule]) => rule),
    ];
    if (rules.length === 0 && extra === false) out.push(`unknown key ${key}`);
    if (rules.length === 0 && isObject(extra)) rules.push(extra);
    out.push(
      ...rules.flatMap((rule) =>
        validate(obj[key], rule, top).map((p) => `${key}: ${p}`),
      ),
    );
  }
  return out;
}
