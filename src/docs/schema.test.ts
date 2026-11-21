import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "../cases.js";
import { CHECKS } from "../checks/index.js";
import { sandbox } from "../testing/sandbox.js";
import { EXAMPLE_CONFIG } from "./reference.js";
import { caseSchema, configSchema } from "./schema.js";

type Json = Record<string, unknown>;
const root = path.resolve(import.meta.dirname, "../..");
const USAGE_ERROR = 2;
const NOT_STRING = '"$schema" must be a string';
const CASES_DIR = "evals/cases/a";
const CONFIG = "skill-evals.config.json";
// Every keyword that this validator knows, which are the ones the schemas use. A schema that uses another one throws.
const NOTES = ["$schema", "$id", "$defs", "title", "description"];
const KEYWORDS = new Set([
  ...NOTES,
  ...`$ref type const enum properties patternProperties additionalProperties required dependentRequired minProperties
    items minItems minLength minimum maximum exclusiveMinimum pattern oneOf anyOf`.split(
    /\s+/,
  ),
]);
const isObject = (v: unknown): v is Json =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const TYPES: Record<string, (value: unknown) => boolean> = {
  object: isObject,
  array: Array.isArray,
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  integer: Number.isInteger,
  boolean: (v) => typeof v === "boolean",
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
function validate(value: unknown, schema: Json, top: Json): string[] {
  const unknown = Object.keys(schema).find((key) => !KEYWORDS.has(key));
  if (unknown) throw new Error(`the validator does not support "${unknown}"`);
  if (typeof schema["$ref"] === "string") {
    const path = schema["$ref"].split("/").slice(2);
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

const caseDoc = caseSchema();
const check = { type: "output_contains", text: "x" };
const problems = (value: unknown): string[] =>
  validate(value, caseDoc, caseDoc);

test("every example case and every compat case validates against case.schema.json", () => {
  const files = ["examples/cases", "test/compat/cases"].flatMap((dir) =>
    fs
      .globSync("**/case.json", { cwd: path.join(root, dir) })
      .map((file) => path.join(root, dir, file)),
  );
  expect(files.length).toBeGreaterThan(5);
  const committed = JSON.parse(
    fs.readFileSync(path.join(root, "schema/case.schema.json"), "utf8"),
  ) as Json;
  for (const file of files) {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    expect(validate(value, committed, committed), file).toEqual([]);
  }
});

test("a known-bad case fails the schema, and each fault names its place", () => {
  expect(problems({ checks: [check] })).toEqual([]);
  expect(problems({})).toContain("missing checks");
  expect(problems({ checks: [] })).toContain("checks: too few items");
  expect(problems({ checks: [check], colour: 1 })).toContain(
    "unknown key colour",
  );
  expect(problems({ checks: [check], "x-mine": [1] })).toEqual([]);
  expect(problems({ checks: [{ type: "nope" }] })).not.toEqual([]);
  expect(problems({ checks: [{ type: "output_contains" }] })).not.toEqual([]);
  expect(problems({ checks: [{ ...check, extra: 1 }] })).not.toEqual([]);
  expect(problems({ checks: [{ type: "tool_called" }] })).not.toEqual([]);
  expect(
    problems({ checks: [{ type: "tool_called", kind: "shell" }] }),
  ).toEqual([]);
  expect(
    problems({ checks: [{ type: "tool_called", kind: "banana" }] }),
  ).not.toEqual([]);
  expect(problems({ checks: [check], minScore: 1.5 })).toContain(
    "minScore: breaks maximum",
  );
  expect(problems({ checks: [check], minDelta: -1.5 })).toContain(
    "minDelta: breaks minimum",
  );
  expect(problems({ checks: [check], minDelta: -0.5, reps: 0 })).toContain(
    "reps: breaks minimum",
  );
  expect(problems({ checks: [check], tags: ["Bad Tag"] })).not.toEqual([]);
  expect(problems({ checks: [check], env: { PATH: "x" } })).not.toEqual([]);
  expect(
    problems({ checks: [check], env: { CASE_A: "x", TZ: "UTC" } }),
  ).toEqual([]);
  expect(problems({ checks: [check], requires: ["bin:git", "mcp"] })).toEqual(
    [],
  );
  expect(problems({ checks: [check], requires: ["telepathy"] })).not.toEqual(
    [],
  );
  expect(problems({ checks: [check], harnesses: ["pi"] })).toContain(
    "harnesses needs note",
  );
  expect(
    problems({ checks: [{ type: "file_exists", path: "../x" }] }),
  ).not.toEqual([]);
  expect(
    problems({
      checks: [{ type: "decision", question: "q", options: { a: 1 } }],
    }),
  ).not.toEqual([]);
});

test("variants: exactly one prompt source, a valid id, strict keys", () => {
  const variant = (more: Json) =>
    problems({ checks: [check], variants: [{ id: "a", ...more }] });
  expect(variant({ prompt: "x" })).toEqual([]);
  expect(
    variant({ promptAppend: "x", heldout: true, tags: ["t"], "x-n": 1 }),
  ).toEqual([]);
  expect(variant({})).not.toEqual([]);
  expect(variant({ prompt: "x", promptAppend: "y" })).not.toEqual([]);
  expect(variant({ prompt: "x", color: 1 })).not.toEqual([]);
  expect(
    problems({ checks: [check], variants: [{ id: "A", prompt: "x" }] }),
  ).not.toEqual([]);
  expect(problems({ checks: [check], variants: [] })).not.toEqual([]);
});

test("$schema is allowed in a case file and the config file, as a string only", async () => {
  expect(problems({ $schema: "./case.schema.json", checks: [check] })).toEqual(
    [],
  );
  expect(problems({ $schema: 1, checks: [check] })).not.toEqual([]);
  const configDoc = configSchema();
  expect(
    validate({ $schema: "x", ...EXAMPLE_CONFIG }, configDoc, configDoc),
  ).toEqual([]);
  expect(validate({ $schema: 1 }, configDoc, configDoc)).not.toEqual([]);
  const box = sandbox();
  box.write(CONFIG, {
    $schema: "./node_modules/skill-evals/schema/config.schema.json",
  });
  box.write(`${CASES_DIR}/prompt.md`, "go\n");
  box.write(`${CASES_DIR}/case.json`, {
    $schema: "../../../schema/case.schema.json",
    checks: [check],
  });
  const ok = await box.cli(["list"]);
  expect(ok.status, ok.stderr).toBe(0);
  box.write(CONFIG, { $schema: 1 });
  expect((await box.cli(["list"])).status).toBe(USAGE_ERROR);
  box.write(CONFIG, {});
  box.write(`${CASES_DIR}/case.json`, { $schema: 1, checks: [check] });
  expect((await box.cli(["list"])).stderr).toContain(NOT_STRING);
  expect(() => validate(1, { format: "x" }, {})).toThrow("does not support");
});

test("the config schema accepts the example config, and rejects an unknown key or a wrong type", () => {
  const doc = configSchema();
  expect(validate(EXAMPLE_CONFIG, doc, doc)).toEqual([]);
  expect(validate({ colour: "red" }, doc, doc)).toContain("unknown key colour");
  expect(validate({ reps: "3" }, doc, doc)).toContain("reps: not number");
  expect(validate({ env: ["SKILL_EVALS_X"] }, doc, doc)).not.toEqual([]);
  expect(validate({ subjectExclude: [""] }, doc, doc)).not.toEqual([]);
});

test("the case schema and the loader agree on what a case may hold", () => {
  const box = sandbox();
  const load = (file: Json): boolean => {
    box.write("cases/c/prompt.md", "go\n");
    box.write("cases/c/case.json", file);
    try {
      loadCases(path.join(box.root, "cases"));
      return true;
    } catch {
      return false;
    }
  };
  const bodies: Json[] = [
    { checks: [check] },
    { checks: [check], harnesses: ["claude-code"] },
    { checks: [check], harnesses: ["claude-code"], note: "n" },
    { checks: [check], harnesses: ["nope"], note: "n" },
    { checks: [{ type: "decision", question: "q", expect: "yes" }] },
    { checks: [{ type: "decision", question: "q", options: { a: 1, b: 0 } }] },
    { checks: [{ type: "judge", rubric: "r", weight: 0 }] },
    { checks: [check], timeoutSeconds: 1.5 },
    { checks: [check], variants: [{ id: "ok", prompt: "p" }] },
    { checks: [check], variants: [{ id: "no way", prompt: "p" }] },
    ...Object.keys(CHECKS).map((type) => ({ checks: [{ type }] })),
  ];
  for (const body of bodies) {
    expect(problems(body).length === 0, JSON.stringify(body)).toBe(load(body));
  }
});
