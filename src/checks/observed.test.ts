import { expect, test } from "vitest";
import { checkScore } from "./index.js";

const score = (mutated: string[], observed?: boolean) =>
  checkScore(
    { type: "subject_unchanged", weight: 1 },
    {
      finalText: "",
      toolCalls: [],
      skillsLoaded: [],
      workspace: "",
      subject: {
        dir: "/copy",
        mutated,
        ...(observed === undefined ? {} : { observed }),
      },
    },
  );

test("subject_unchanged scores 1 when nothing changed", () => {
  expect(score([])).toEqual({ score: 1 });
});

test("subject_unchanged lists at most ten changed paths", () => {
  const paths = Array.from({ length: 12 }, (_, index) => `f${String(index)}`);
  expect(score(paths.slice(0, 2))).toEqual({
    score: 0,
    reason: "changed: f0, f1",
  });
  expect(score(paths)).toEqual({
    score: 0,
    reason: "changed: f0, f1, f2, f3, f4, f5, f6, f7, f8, f9 and 2 more",
  });
});

test("subject_unchanged scores 0, never 1, when the copy could not be observed", () => {
  expect(score([], false)).toEqual({
    score: 0,
    reason: "the subject copy could not be observed",
  });
  expect(score([], true)).toEqual({ score: 1 });
});
