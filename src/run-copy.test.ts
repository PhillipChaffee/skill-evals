import { expect, test } from "vitest";
import { copyOf, observe } from "./run-copy.js";
import type { Copy } from "./run-copy.js";
import type { SessionResult } from "./session.js";
import type { Subject } from "./subject.js";

const NONE = { created: [], modified: [], deleted: [] };
const copy = (kind: "plugin" | "skills"): Copy => ({
  dir: "/copy",
  changes: () => ({ ...NONE, modified: ["a"] }),
  dispose: () => undefined,
  loaded: { kind, dir: "/copy", skills: [], skillDirs: {} },
  rules: null,
});
const ran = (placedChanges: SessionResult["placedChanges"]) =>
  ({ placedChanges }) as SessionResult;

test("a skills folder is observed only when the placed copies were watched", () => {
  expect(observe(copy("skills"), ran(null)).observed).toBe(false);
  expect(observe(copy("skills"), ran(NONE)).observed).toBe(true);
  expect(observe(copy("plugin"), ran(null)).observed).toBe(true);
  expect(observe(null, ran(null))).toEqual({ changes: null, observed: true });
});

test("the changes of the placed copies join those of the subject copy", () => {
  const placed = { ...NONE, modified: ["greet/SKILL.md"] };
  expect(observe(copy("skills"), ran(placed)).changes?.modified).toEqual([
    "a",
    "greet/SKILL.md",
  ]);
});

test("a run does not start from an export that an earlier run edited", () => {
  const subject = {
    kind: "plugin",
    dir: "/source",
    exported: "/export",
    exportChanged: () => ["skills/x/SKILL.md"],
  } as unknown as Subject;
  expect(() => copyOf(subject)).toThrow(
    /edited the exported copy of the subject.*skills\/x\/SKILL\.md/,
  );
});
