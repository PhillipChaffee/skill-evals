import { expect, test } from "vitest";
import { UsageError } from "../scope.js";
import type { FieldDef, FieldType } from "./fields.js";
import {
  FIELDS,
  REGEX_FIELDS,
  WEIGHT,
  extensionsOf,
  readField,
  registerParser,
} from "./fields.js";

const at = { where: "case.json", owner: "a check", siblings: {} };
const defs = (type: FieldType, more: Partial<FieldDef> = {}) => ({
  field: { type, meaning: "x", ...more },
});
const read = (type: FieldType, value: unknown, more: Partial<FieldDef> = {}) =>
  readField(defs(type, more), "field", { ...at, siblings: { field: value } });

type Row = [FieldType, unknown, unknown[], RegExp, Partial<FieldDef>?];
// Each type with a value it reads, and values it rejects with the message it gives.
const CASES: Row[] = [
  ["text", "a", [1, "", null], /a check needs a string "field"/],
  ["regex", "a+", [1, "("], /needs a string|Invalid regular expression/],
  ["flags", "gi", ["z", 1], /Invalid flags|needs a string/],
  [
    "path",
    "a/b.txt",
    ["../a", "/etc", "a\\..\\b"],
    /inside the workspace|needs/,
  ],
  ["glob", "src/*.ts", [1], /needs a string "field"/],
  ["kind", "shell", ["terminal", 1], /unknown tool kind "terminal"|needs/],
  ["int", 3, [0, 1.5, "1"], /field must be a positive integer/],
  ["unit", 0.5, [2, "1", -1], /field must be a number from 0 to 1/],
  ["number", 2.5, [0, "1", Infinity], /field must be a positive number/],
  ["bool", false, [0, "true"], /field must be true or false/],
  [
    "enum",
    "no",
    ["maybe", 1],
    /"field" must be "yes" or "no"|needs/,
    { values: ["yes", "no"] },
  ],
  ["texts", ["a", "b"], [[], [""], "a", [1]], /non-empty list of non-empty/],
  ["matcher", { a: 1 }, [null, [], "a"], /"field" must be an object/],
  ["matchers", [{ a: 1 }], [{}, [1], "a"], /list of objects/],
  ["object", { a: 1 }, [null, [], 1], /"field" must be an object/],
];

for (const [type, good, bad, message, more] of CASES) {
  test(`the ${type} parser reads a good value and rejects a bad one`, () => {
    expect(read(type, good, more)).toEqual(good);
    for (const value of bad) {
      expect(() => read(type, value, more)).toThrow(UsageError);
      expect(() => read(type, value, more)).toThrow(message);
    }
  });
}

test("an object field says what it expects when its table says so", () => {
  expect(() => read("object", null, { expected: "a bag of two" })).toThrow(
    /"field" must be a bag of two/,
  );
});

test("a regex is compiled with the flags of the same object", () => {
  const field = defs("regex");
  const given = (flags?: string) => ({
    ...at,
    siblings: { field: String.raw`a\-b`, flags },
  });
  // An escaped hyphen is valid, except with the u flag.
  expect(readField(field, "field", given())).toBe(String.raw`a\-b`);
  expect(() => readField(field, "field", given("u"))).toThrow(
    /Invalid regular expression/,
  );
});

test("a field the table does not define is an unknown key", () => {
  const given = { ...at, siblings: { pth: "a", constructor: "a" } };
  expect(() => readField(FIELDS, "pth", given)).toThrow(
    /case.json: unknown key "pth"/,
  );
  expect(() => readField(FIELDS, "constructor", given)).toThrow(/unknown key/);
});

test("the table types the fields that exist today, and the regex fields come from it", () => {
  expect(FIELDS["pattern"]?.type).toBe("regex");
  expect(FIELDS["expect"]?.values).toEqual(["yes", "no"]);
  expect(REGEX_FIELDS).toEqual(["pattern", "name", "inputMatches"]);
  expect(read("number", 1, WEIGHT)).toBe(1);
});

test("another module can register the parser of a type without importing it here", () => {
  const seen: unknown[] = [];
  const plain = registerParser("matcher", (value, parserAt) => {
    seen.push(parserAt.name);
    if (value === "bad") throw new UsageError(`${parserAt.where}: bad matcher`);
    return { registered: value };
  });
  try {
    expect(read("matcher", "ok")).toEqual({ registered: "ok" });
    expect(seen).toEqual(["field"]);
    expect(() => read("matcher", "bad")).toThrow(/case.json: bad matcher/);
  } finally {
    registerParser("matcher", plain);
  }
  expect(read("matcher", { a: 1 })).toEqual({ a: 1 });
});

test("extensionsOf keeps x- keys, fails on others, and in lenient mode warns and drops them", () => {
  const where = {
    where: "f",
    owner: "a check",
    siblings: { a: 1, "x-a": 2, b: 3 },
  };
  expect(() => extensionsOf(["a"], where, { lenient: false })).toThrow(
    /f: unknown key "b" for a check; allowed: a/,
  );
  const warned: string[] = [];
  const kept = extensionsOf(["a"], where, {
    lenient: true,
    warn: (text) => warned.push(text),
  });
  expect(kept).toEqual({ "x-a": 2 });
  expect(warned).toEqual(['f: ignored unknown key "b"']);
  expect(extensionsOf(["a"], where, { lenient: true })).toEqual(kept);
});
