import { expect, test } from "vitest";
import { noiseSubjectOf } from "./noise-subject.js";
import type { SubjectSummary } from "./subject.js";

const summary = (more: Partial<SubjectSummary>): SubjectSummary => ({
  label: "a",
  spec: "none",
  kind: "none",
  dir: null,
  skills: [],
  commit: null,
  ...more,
});

test("a noise file names a directory by its path, a git ref and none by the spec, with the options or null", () => {
  expect(noiseSubjectOf(summary({}))).toEqual({ label: "none", options: null });
  expect(
    noiseSubjectOf(
      summary({
        spec: "kit",
        kind: "plugin",
        dir: "/abs/kit",
        options: "hooks=off",
      }),
    ),
  ).toEqual({ label: "/abs/kit", options: "hooks=off" });
  expect(
    noiseSubjectOf(
      summary({
        spec: "main",
        kind: "plugin",
        dir: "/abs/project",
        commit: "abc",
      }),
    ),
  ).toEqual({ label: "main", options: null });
});
