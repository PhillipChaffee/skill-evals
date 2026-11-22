import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { sandbox } from "./testing/sandbox.js";
import type { Sandbox } from "./testing/sandbox.js";

const DONE = { type: "output_contains", text: "done" };
const SHOP = "../_shared/shop";

/**
 * Plants a case with these keys and files.
 * @param box - The sandbox.
 * @param more - Keys of the case file besides the checks.
 * @param files - Files below the case's directory.
 * @returns A function that loads the cases directory.
 */
function load(
  box: Sandbox,
  more: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  box.write("cases/c/prompt.md", "p\n");
  box.write("cases/c/case.json", { checks: [DONE], ...more });
  for (const [name, content] of Object.entries(files)) {
    box.write(`cases/c/${name}`, content);
  }
  return () => loadCases(path.join(box.root, "cases"));
}

test("fixtures must exist and stay inside the cases directory", () => {
  const missing = load(sandbox(), { fixtures: ["../_shared/none"] });
  expect(missing).toThrow(/fixtures: .*_shared\/none does not exist/);
  const box = sandbox();
  box.write("outside/a.txt", "a");
  const escaping = load(box, { fixtures: ["../../outside"] });
  expect(escaping).toThrow(
    /fixtures: ..\/..\/outside is outside the cases directory/,
  );
  const file = sandbox();
  file.write("cases/_shared/f.txt", "x");
  expect(load(file, { fixtures: ["../_shared/f.txt"] })).toThrow(
    /is not a directory/,
  );
});

test("a link in a fixture, the fixture directory or home that leaves its tree is a load error", () => {
  const box = sandbox();
  box.write("cases/_shared/shop/a.txt", "a");
  fs.symlinkSync(
    "../../../../secret",
    path.join(box.root, "cases/_shared/shop/escape"),
  );
  expect(load(box, { fixtures: [SHOP] })).toThrow(/escape is a link to/);
  const withFixture = sandbox();
  const run = load(withFixture, {}, { "fixture/s.sh": "x" });
  fs.symlinkSync("/etc", path.join(withFixture.root, "cases/c/fixture/abs"));
  expect(run).toThrow(/fixture\/abs is a link to \/etc/);
  const withHome = sandbox();
  const home = load(withHome, { home: "home" }, { "home/a": "x" });
  fs.symlinkSync("/etc", path.join(withHome.root, "cases/c/home/abs"));
  expect(home).toThrow(/home\/abs is a link to \/etc/);
});

test("a home file at a login file path is a load error", () => {
  const run = load(
    sandbox(),
    { home: "home" },
    { "home/.codex/auth.json": "{}" },
  );
  expect(run).toThrow(/home\/.codex\/auth.json is a login file of codex/);
  const other = load(
    sandbox(),
    { home: "home" },
    { "home/.claude/.credentials.json": "{}" },
  );
  expect(other).toThrow(/login file of claude-code/);
});

test("home must be a directory of the case", () => {
  expect(load(sandbox(), { home: "nothing" })).toThrow(
    /home: nothing does not exist/,
  );
  expect(load(sandbox(), { home: "../x" })).toThrow(
    /home: ..\/x must stay inside the case/,
  );
  expect(load(sandbox(), { home: "prompt.md" })).toThrow(
    /home: prompt.md is not a directory/,
  );
});

test("setup steps are checked at load", () => {
  const bad = (setup: unknown) => load(sandbox(), { setup });
  expect(bad([])).toThrow(/"setup" must be a non-empty list/);
  expect(bad([{}])).toThrow(/step 1 must have exactly one of "run" and "git"/);
  expect(bad([{ run: "x", git: {} }])).toThrow(/exactly one of/);
  expect(bad([{ run: "" }])).toThrow(
    /step 1: "run" must be a non-empty string/,
  );
  expect(bad([{ run: "x", extra: 1 }])).toThrow(/step 1: unknown key "extra"/);
  expect(bad([{ run: "x", timeoutSeconds: 0 }])).toThrow(
    /"timeoutSeconds" must be a positive integer/,
  );
  expect(bad([{ git: {} }])).toThrow(/step 1: "git" needs at least one of/);
  expect(bad([{ git: { init: true, nope: 1 } }])).toThrow(
    /step 1: git: unknown key "nope"/,
  );
  expect(bad([{ git: { init: "yes" } }])).toThrow(
    /git.init must be true or false/,
  );
  expect(bad([{ git: { branch: "main" } }])).toThrow(
    /git.branch needs "init": true/,
  );
  expect(bad([{ git: { init: true, branch: "-x" } }])).toThrow(/git.branch/);
  expect(bad([{ git: { commitAll: "" } }])).toThrow(
    /git.commitAll must be a non-empty string/,
  );
  expect(bad([{ git: { remote: "up stream" } }])).toThrow(/git.remote/);
  expect(bad("x")).toThrow(/"setup" must be a non-empty list/);
  expect(bad([5])).toThrow(/step 1 must be an object/);
});

test("a fixture folder that is a file, and a fixture path that is a link out of the cases directory, are load errors", () => {
  const file = sandbox();
  expect(load(file, {}, { fixture: "x" })).toThrow(
    /fixture must be a directory/,
  );
  const box = sandbox();
  box.write("outside/a.txt", "a");
  fs.mkdirSync(path.join(box.root, "cases/_shared"), { recursive: true });
  fs.symlinkSync(
    path.join(box.root, "outside"),
    path.join(box.root, "cases/_shared/out"),
  );
  expect(load(box, { fixtures: ["../_shared/out"] })).toThrow(
    /outside the cases directory/,
  );
});

test("fixtures and home refuse a folder that is, holds or sits in a case's own files", () => {
  const files = { "grader/secret.sh": "x", "fixture/s.sh": "x", "home/a": "x" };
  const held = /would copy a case folder, or a grader\/ or fixture\/ folder/;
  for (const named of [".", "grader", "fixture"]) {
    expect(load(sandbox(), { fixtures: [named] }, files), named).toThrow(held);
  }
  expect(load(sandbox(), { fixtures: ["../c/grader", "."] }, files)).toThrow(
    held,
  );
  for (const named of ["grader", "fixture", "grader/sub", "fixture/sub"]) {
    const box = sandbox();
    box.write("cases/c/grader/sub/x", "x");
    box.write("cases/c/fixture/sub/x", "x");
    expect(load(box, { home: named }, files), named).toThrow(held);
  }
});

test("a shared folder that holds another case is refused, and one with an ordinary tree is not", () => {
  const box = sandbox();
  box.write("cases/_shared/shop/package.json", "{}");
  box.write("cases/groups/shop/other/case.json", "{}");
  expect(load(box, { fixtures: ["../groups/shop"] })).toThrow(
    /would copy a case folder/,
  );
  const ok = sandbox();
  ok.write("cases/_shared/shop/package.json", "{}");
  ok.write("cases/other/prompt.md", "p");
  ok.write("cases/other/case.json", { checks: [DONE] });
  ok.write("cases/other/workspace/a.txt", "a");
  const cases = load(ok, {
    fixtures: [SHOP, "../other/workspace"],
  })();
  expect(cases.map((one) => one.id)).toEqual(["c", "other"]);
});

test("a shared folder with a data prompt.md or a nested case.json is not a case and loads", () => {
  const box = sandbox();
  box.write("cases/_shared/s/prompt.md", "data, not a prompt");
  box.write("cases/_shared/s/sub/case.json", "{}");
  const cases = load(box, { fixtures: ["../_shared/s"] })();
  expect(cases.map((one) => one.id)).toEqual(["c"]);
});

test("an ordinary folder with a data file named case.json inside a case is not refused as a nested case", () => {
  const box = sandbox();
  box.write("cases/other/prompt.md", "p");
  box.write("cases/other/case.json", { checks: [DONE] });
  box.write("cases/other/workspace/prompt.md", "data");
  box.write("cases/other/workspace/sub/case.json", "{}");
  expect(load(box, { fixtures: ["../other/workspace"] })()).toHaveLength(2);
});

test("a fixtures folder that holds a case-shaped folder under an underscore folder is data and loads", () => {
  const box = sandbox();
  box.write("cases/_shared/s/_x/case/case.json", "{}");
  box.write("cases/_shared/s/_x/case/grader/check.sh", "x");
  const cases = load(box, { fixtures: ["../_shared/s"] })();
  expect(cases.map((one) => one.id)).toEqual(["c"]);
});

test("fixtures may not name the cases directory itself", () => {
  expect(load(sandbox(), { fixtures: [".."] })).toThrow(
    /fixtures: \.\. is outside the cases directory/,
  );
});
