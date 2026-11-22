import { expect, test } from "vitest";
import { UsageError } from "../scope.js";
import { extensionsOf } from "./extensions.js";
import type { FieldDef, FieldType } from "./fields.js";
import {
  FIELDS,
  REGEX_FIELDS,
  WEIGHT,
  readField,
  registerParser,
} from "./fields.js";

const at = { where: "case.json", owner: "a check", siblings: {} };
const defs = (type: FieldType, more: Partial<FieldDef> = {}) => ({
  field: { type, meaning: "x", ...more },
});
const read = (type: FieldType, value: unknown, more: Partial<FieldDef> = {}) =>
  readField(defs(type, more), "field", { ...at, siblings: { field: value } });

type Bad = [value: unknown, message: RegExp];
type Row = [FieldType, unknown, Bad[], Partial<FieldDef>?];
const NEEDS_TEXT = /a check needs a string "field"/;
const OBJECT = /"field" must be an object/;
// Each type with a value it reads, and each value it rejects with the one message it gives.
const CASES: Row[] = [
  [
    "text",
    "a",
    [
      [1, NEEDS_TEXT],
      ["", NEEDS_TEXT],
      [null, NEEDS_TEXT],
    ],
  ],
  [
    "regex",
    "a+",
    [
      [1, NEEDS_TEXT],
      ["(", /Invalid regular expression/],
    ],
  ],
  [
    "flags",
    "gi",
    [
      ["z", /Invalid flags/],
      [1, NEEDS_TEXT],
    ],
  ],
  [
    "path",
    "a/b.txt",
    [
      ["../a", /path must stay inside the workspace: \.\.\/a/],
      ["/etc", /path must stay inside the workspace: \/etc/],
      ["a\\..\\b", /path must stay inside the workspace/],
      [1, NEEDS_TEXT],
    ],
  ],
  ["glob", "src/*.ts", [[1, NEEDS_TEXT]]],
  [
    "kind",
    "shell",
    [
      ["terminal", /unknown tool kind "terminal"; known: shell/],
      [1, NEEDS_TEXT],
    ],
  ],
  [
    "int",
    3,
    [0, 1.5, "1"].map((v): Bad => [v, /field must be a positive integer/]),
  ],
  [
    "count",
    0,
    [-1, 1.5, "1"].map((v): Bad => [
      v,
      /field must be a whole number, 0 or more/,
    ]),
  ],
  [
    "unit",
    0.5,
    [2, "1", -1].map((v): Bad => [v, /field must be a number from 0 to 1/]),
  ],
  [
    "signed",
    -0.2,
    [-1.5, 1.5, "0"].map((v): Bad => [
      v,
      /field must be a number from -1 to 1/,
    ]),
  ],
  [
    "number",
    2.5,
    [0, "1", Infinity].map((v): Bad => [v, /field must be a positive number/]),
  ],
  [
    "bool",
    false,
    [0, "true"].map((v): Bad => [v, /field must be true or false/]),
  ],
  [
    "enum",
    "no",
    [
      ["maybe", /"field" must be "yes" or "no"/],
      [1, NEEDS_TEXT],
    ],
    { values: ["yes", "no"] },
  ],
  [
    "texts",
    ["a", "b"],
    [[], [""], "a", [1]].map((v): Bad => [
      v,
      /non-empty list of non-empty strings/,
    ]),
  ],
  [
    "tags",
    ["smoke", "a-1"],
    [["Smoke"], ["-a"], [""], "smoke", [1]].map((v): Bad => [
      v,
      /"field" must be a list of tags/,
    ]),
  ],
  [
    "envvars",
    { CASE_A: "1", TZ: "UTC", LANG: "C", LC_ALL: "C" },
    [
      [{ PATH: "x" }, /field cannot set "PATH": A name must start with/],
      [{ CASE_A: 1 }, /field "CASE_A" must be a string/],
      [
        { "CASE_A=": "x" },
        /field cannot set "CASE_A=": has an `=`, so it is not a variable name/,
      ],
      [{ CASE_A: "a\0" }, /"CASE_A" must be a string without a NUL/],
      [["CASE_A"], /"field" must be an object of variable values/],
    ],
  ],
  [
    "needs",
    ["mcp", "bin:git"],
    [
      [["telepathy"], /unknown capability "telepathy"; known: subagents/],
      [["bin:a b"], /unknown capability "bin:a b"/],
      [[1], /unknown capability 1;/],
      ["mcp", /"requires" must be a list of capability names/],
    ],
  ],
  ["matcher", { a: 1 }, [null, [], "a"].map((v): Bad => [v, OBJECT])],
  [
    "matchers",
    [{ a: 1 }],
    [{}, [1], "a"].map((v): Bad => [v, /"field" must be a list of objects/]),
  ],
  ["object", { a: 1 }, [null, [], 1].map((v): Bad => [v, OBJECT])],
];

for (const [type, good, bad, more] of CASES) {
  test(`the ${type} parser reads a good value and rejects each bad one`, () => {
    expect(read(type, good, more)).toEqual(good);
    for (const [value, message] of bad) {
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
  expect(REGEX_FIELDS).toEqual([
    ...["pattern", "name", "inputMatches"],
    ...["stdoutMatches", "stdoutLacks"],
  ]);
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
