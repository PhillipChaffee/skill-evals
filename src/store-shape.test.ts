import { expect, test } from "vitest";
import { isStoredRun } from "./store-shape.js";

const LINE = {
  key: "k",
  attempt: 1,
  harness: "h",
  caseId: "c",
  subject: "s",
  rep: 1,
  ok: true,
  error: null,
  finalText: "",
  subjectLoaded: null,
  isolated: false,
  unexpected: [],
  reportMissing: false,
  judgeProblem: null,
  checks: [],
  score: 1,
  durationMs: 1,
  tokens: null,
  costUsd: null,
  judge: null,
  decision: null,
};

test("canaryChanges is a record of two lists of texts, or it is absent", () => {
  expect(isStoredRun(LINE)).toBe(true);
  const stored = (canaryChanges: unknown): boolean =>
    isStoredRun({ ...LINE, canaryChanges });
  expect(stored({ changed: ["~/.ssh/a (created)"], problems: [] })).toBe(true);
  for (const wrong of [
    [],
    "x",
    { changed: [], problems: [1] },
    { changed: [2], problems: [] },
    { changed: [] },
    { problems: [] },
    { changed: "a", problems: [] },
  ]) {
    expect(stored(wrong), JSON.stringify(wrong)).toBe(false);
  }
});
