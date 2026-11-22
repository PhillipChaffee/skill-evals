import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { sandbox } from "./testing/sandbox.js";
import { CHECK, failure, plant } from "./testing/turns-case.js";

test("a variant of a case with turns must give turns, never a prompt that drops them", () => {
  for (const key of ["prompt", "promptAppend"]) {
    expect(
      failure(sandbox(), {
        turns: [{ prompt: "one.md", checks: [CHECK] }],
        variants: [{ id: "hurry", [key]: "do it now" }],
      }),
    ).toBe(
      `ROOT/cases/talk/case.json variants[0]: the case has "turns", so a variant must give "turns" too; "${key}" would drop them and every check of a turn`,
    );
  }
  const [kept] = loadCases(
    plant(sandbox(), {
      turns: [{ prompt: "one.md" }],
      variants: [
        { id: "same", turns: [{ prompt: "two.md", checks: [CHECK] }] },
      ],
    }),
  );
  expect(kept?.turns?.[0]?.checks).toHaveLength(1);
});

test("a case whose checks are all in its turns loads; one with no check anywhere does not", () => {
  const [found] = loadCases(
    plant(sandbox(), {
      checks: undefined,
      turns: [{ prompt: "one.md", checks: [CHECK] }],
    }),
  );
  expect(found?.checks).toEqual([]);
  expect(found?.turns?.[0]?.checks).toHaveLength(1);
  const none = {
    checks: undefined,
    turns: [{ prompt: "one.md" }],
  };
  expect(failure(sandbox(), none)).toBe(
    'ROOT/cases/talk/case.json: a case needs at least one check, in "checks" or in a turn',
  );
  expect(
    failure(sandbox(), { turns: [{ prompt: "one.md" }], checks: [] }),
  ).toBe('ROOT/cases/talk/case.json: "checks" must be a non-empty array');
});

test("clear and resume turns send nothing, so they take no checks", () => {
  for (const event of ["clear", "resume"]) {
    expect(
      failure(sandbox(), {
        turns: [{ prompt: "one.md" }, { event, checks: [CHECK] }],
      }),
    ).toContain(`a ${event} turn sends nothing, so it has no checks`);
  }
  expect(
    failure(sandbox(), {
      turns: [{ prompt: "one.md" }, { event: "compact", checks: [CHECK] }],
    }),
  ).toBe("");
});
