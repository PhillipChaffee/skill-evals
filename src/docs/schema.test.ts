import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "../cases.js";
import { CHECKS } from "../checks/index.js";
import { sandbox } from "../testing/sandbox.js";
import { EXAMPLE_CONFIG } from "./reference.js";
import { caseSchema, configSchema } from "./schema.js";

import type { Json } from "../testing/schema-validator.js";
import { validate } from "../testing/schema-validator.js";

const root = path.resolve(import.meta.dirname, "../..");
const USAGE_ERROR = 2;
const NOT_STRING = '"$schema" must be a string';
const CASES_DIR = "evals/cases/a";
const CONFIG = "skill-evals.config.json";
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

// Checks that hold matchers: the schema renders a matcher as a strict object, and the loader agrees.
const MATCHER_BODIES: Json[] = [
  { checks: [{ type: "first_tool", matches: { kind: "skill" } }] },
  { checks: [{ type: "first_tool", matches: { kind: "nope" } }] },
  { checks: [{ type: "first_tool", matches: { flags: "i" } }] },
  { checks: [{ type: "first_tool", matches: { kind: "edit", by: {} } }] },
  { checks: [{ type: "first_tool", matches: { kind: "edit", extra: 1 } }] },
  { checks: [{ type: "first_tool", matches: { name: "a" }, ignoring: [] }] },
  {
    checks: [
      {
        type: "tool_order",
        before: { kind: "edit", which: "last" },
        after: { name: "Bash", flags: "i" },
      },
    ],
  },
  {
    checks: [
      {
        type: "tool_order",
        before: { kind: "edit", which: "middle" },
        after: { kind: "read" },
      },
    ],
  },
  { checks: [{ type: "tool_order", sequence: [{ kind: "edit" }] }] },
  { checks: [{ type: "tool_order", sequence: [] }] },
  { checks: [{ type: "tool_order", sequence: [{ kind: "edit" }], strict: 1 }] },
  { checks: [{ type: "tool_order", before: { kind: "edit" } }] },
  {
    checks: [
      {
        type: "tool_order",
        before: { kind: "edit" },
        after: { kind: "read" },
        strict: true,
      },
    ],
  },
  {
    checks: [
      { type: "skill_loaded", skill: "a", ignoring: [{ kind: "read" }] },
    ],
  },
  {
    checks: [
      {
        type: "skill_loaded",
        skill: "a",
        first: true,
        ignoring: [{ kind: "read" }],
      },
    ],
  },
  { checks: [{ type: "tool_called", kind: "edit", min: -1 }] },
  { checks: [{ type: "skill_loaded", anyOf: ["a", "b"], first: true }] },
  { checks: [{ type: "skill_loaded", anyOf: [] }] },
  { checks: [{ type: "skill_loaded", skill: "a", anyOf: ["b"] }] },
];

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
    { checks: [check], weight: null },
    { checks: [{ ...check, weight: null }] },
    { checks: [check], weight: 0 },
    ...Object.keys(CHECKS).map((type) => ({ checks: [{ type }] })),
    ...MATCHER_BODIES,
  ];
  for (const body of bodies) {
    expect(problems(body).length === 0, JSON.stringify(body)).toBe(load(body));
  }
});

test("the schema is looser than the loader for a whitespace-only prompt, and the gaps are the documented ones", () => {
  const box = sandbox();
  const loads = (file: Json): boolean => {
    box.write("cases/c/prompt.md", "go\n");
    box.write("cases/c/case.json", file);
    try {
      loadCases(path.join(box.root, "cases"));
      return true;
    } catch {
      return false;
    }
  };
  const gaps: Json[] = [
    { checks: [check], variants: [{ id: "a", prompt: "  " }] },
    { checks: [check], variants: [{ id: "a", promptAppend: "  " }] },
    {
      checks: [check],
      variants: [
        { id: "a", prompt: "x" },
        { id: "a", prompt: "y" },
      ],
    },
    { checks: [{ type: "output_matches", pattern: "(" }] },
    { checks: [{ type: "output_matches", pattern: "a", flags: "zz" }] },
    {
      checks: [{ type: "decision", question: "q", options: { "": 1, b: 0 } }],
    },
    {
      checks: [
        {
          type: "tool_order",
          sequence: [{ kind: "edit" }],
          before: { kind: "edit" },
        },
      ],
    },
    { checks: [{ type: "tool_called", kind: "edit", min: 2, max: 0 }] },
  ];
  for (const body of gaps) {
    expect(problems(body), JSON.stringify(body)).toEqual([]);
    expect(loads(body), JSON.stringify(body)).toBe(false);
  }
});

test("case and check weights accept null but not a negative number", () => {
  expect(problems({ checks: [check], weight: null })).toEqual([]);
  expect(problems({ checks: [{ ...check, weight: null }] })).toEqual([]);
  expect(problems({ checks: [check], weight: -1 })).not.toEqual([]);
});

test("building the check schemas throws when a check spec names a field that FIELDS lacks", () => {
  CHECKS["ghost"] = { fields: ["nothing"], scores: "x" };
  try {
    expect(() => caseSchema()).toThrow(
      "check ghost: field nothing is not in FIELDS",
    );
  } finally {
    delete CHECKS["ghost"];
  }
  expect(() => caseSchema()).not.toThrow();
});
