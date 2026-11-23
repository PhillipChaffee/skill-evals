import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import setup from "./neutral-env.js";

const given = process.env["TMPDIR"];
// The TMPDIR that the last setup set, read afresh each time.
const current = (): string => String(process.env["TMPDIR"]);
afterEach(() => {
  process.env["TMPDIR"] = given;
});

test("the global setup makes one temp directory for the run, and its teardown removes it", () => {
  const teardown = setup();
  const made = current();
  expect(path.dirname(made)).toBe(fs.realpathSync(String(given)));
  expect(path.basename(made)).toMatch(/^runs-/);
  fs.writeFileSync(path.join(made, "kept.txt"), "x");
  teardown();
  expect(fs.existsSync(made)).toBe(false);
});

test("the teardown fails the run when a test left a sandbox directory, and still removes everything", () => {
  const teardown = setup();
  const made = current();
  fs.mkdirSync(path.join(made, "runs-left"));
  expect(teardown).toThrow("the tests left 1 sandbox directories: runs-left");
  expect(fs.existsSync(made)).toBe(false);
});

test("a temp directory whose path holds a blinding word is not the parent", () => {
  const worded = fs.mkdtempSync(path.join(os.tmpdir(), "evaluation-"));
  process.env["TMPDIR"] = worded;
  const teardown = setup();
  const made = current();
  try {
    expect(path.dirname(made)).toBe(fs.realpathSync("/tmp"));
  } finally {
    teardown();
    fs.rmSync(worded, { recursive: true, force: true });
  }
});
