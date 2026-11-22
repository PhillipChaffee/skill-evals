import { expect, test } from "vitest";
import { stepCommand } from "./setup-steps.js";

test("a git step expands to init, commit and remote, in that order", () => {
  expect(
    stepCommand({
      git: { init: true, commitAll: "initial", remote: "origin" },
    }),
  ).toBe(
    'git init -q -b main && git add -A && git commit -q -m initial && git init -q --bare "$SKILL_EVALS_REMOTE_DIR/origin.git" && git remote add origin "$SKILL_EVALS_REMOTE_DIR/origin.git" && git push -q -u origin HEAD',
  );
  expect(stepCommand({ git: { init: true, branch: "trunk" } })).toBe(
    "git init -q -b trunk",
  );
});

test("a git step quotes its message and leaves out what it was not asked", () => {
  expect(stepCommand({ git: { commitAll: "it's done; rm -rf x" } })).toBe(
    "git add -A && git commit -q -m 'it'\\''s done; rm -rf x'",
  );
  expect(stepCommand({ git: { remote: "backup" } })).toContain(
    'git remote add backup "$SKILL_EVALS_REMOTE_DIR/backup.git"',
  );
  expect(stepCommand({ run: "echo hi" })).toBe("echo hi");
});
