import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { plantCase } from "./testing/plant.js";
import { sandbox } from "./testing/sandbox.js";

/**
 * Loads a case that holds one check and returns the load error.
 * @param check - The check, as a case file holds it.
 * @returns The error message, or null when it loads.
 */
function loadError(check: unknown): string | null {
  const box = sandbox();
  const cases = plantCase(box, [check]);
  try {
    loadCases(cases);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

test.each([
  [
    { type: "judge", rubric: "r", sees: ["files"] },
    /sees "files" needs "files"/,
  ],
  [
    { type: "judge", rubric: "r", files: ["a"] },
    /"files" needs "sees" to include "files"/,
  ],
  [
    { type: "judge", rubric: "r", maxChars: 10 },
    /"maxChars" needs "sees" to include "transcript"/,
  ],
  [
    { type: "judge", rubric: "r", sees: ["eyes"] },
    /"sees" must be a non-empty list of/,
  ],
  [
    { type: "judge", rubric: "r", sees: ["final", "final"] },
    /"sees" must be a non-empty list of/,
  ],
  [
    { type: "judge", rubric: "r", votes: 2 },
    /votes must be an odd positive integer/,
  ],
  [{ type: "judge", rubric: "r", votes: 0 }, /votes must be/],
  [
    { type: "judge", rubric: "r", scale: "ten" },
    /"scale" must be "binary" or "0-1"/,
  ],
  [
    { type: "judge", rubric: { pass: "a" } },
    /rubric must be text or an object with "pass" and "fail"/,
  ],
  [
    { type: "judge", rubric: { pass: "a", fail: "b", extra: "c" } },
    /rubric must be text or/,
  ],
  [
    { type: "decision", question: "q", expect: "yes", votes: 3 },
    /unknown key "votes"/,
  ],
  [
    { type: "decision", question: "q", expect: "yes", scale: "binary" },
    /unknown key "scale"/,
  ],
])("%j is a load error", (check, message) => {
  expect(loadError(check)).toMatch(message);
});

test("the new judge fields load", () => {
  expect(
    loadError({
      type: "judge",
      rubric: { pass: "a", fail: "b" },
      scale: "binary",
      votes: 3,
      sees: ["final", "transcript", "files"],
      files: ["a/**"],
      maxChars: 1000,
    }),
  ).toBeNull();
});
