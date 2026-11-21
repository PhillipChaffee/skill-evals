import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { CHECKS, plant } from "./testing/nested.js";
import { sandbox } from "./testing/sandbox.js";

const idsIn = (dir: string, glob?: string): string[] =>
  loadCases(dir, glob).map((found) => found.id);

test("cases load from nested directories with path ids", () => {
  const box = sandbox();
  plant(box, "routing/bug/first");
  plant(box, "routing/bug/second");
  const dir = plant(box, "flat");
  expect(idsIn(dir)).toEqual([
    "flat",
    "routing/bug/first",
    "routing/bug/second",
  ]);
});

test("dots and hyphens in ids stay legal and globs match them", () => {
  const box = sandbox();
  plant(box, "core/trig.rsch.research.01");
  plant(box, "core/other-case");
  const dir = plant(box, "core/trig-rsch");
  expect(idsIn(dir, "core/trig.rsch.*")).toEqual([
    "core/trig.rsch.research.01",
  ]);
  expect(idsIn(dir, "core/*")).toHaveLength(3);
});

test("a directory that starts with an underscore is never a case, nor is anything under it", () => {
  const box = sandbox();
  plant(box, "_shared");
  plant(box, "routing/_draft/inner");
  plant(box, "routing/_draft");
  const dir = plant(box, "routing/kept");
  expect(idsIn(dir)).toEqual(["routing/kept"]);
});

test("a directory inside a case is not a case", () => {
  const box = sandbox();
  const dir = plant(box, "outer");
  plant(box, "outer/inner");
  box.write("cases/outer/workspace/prompt.md", "# not a prompt\n");
  expect(idsIn(dir)).toEqual(["outer"]);
});

test("an @ or a comma in a directory name of a case id is a load error", () => {
  const at = sandbox();
  expect(() => loadCases(plant(at, "routing/a@b"))).toThrow(
    /case routing\/a@b: a directory name may not hold "@" or ","/,
  );
  const comma = sandbox();
  expect(() => loadCases(plant(comma, "a,b/c"))).toThrow(
    /may not hold "@" or ","/,
  );
  // Only a case id is checked: a directory that holds no case may have any name, and so may one that is skipped.
  const fine = sandbox();
  fine.write("cases/a@b/notes.txt", "x");
  plant(fine, "_a@b/c");
  expect(idsIn(plant(fine, "ok"))).toEqual(["ok"]);
});

test("a case file with no prompt source is a load error", () => {
  const box = sandbox();
  box.write("cases/lonely/case.json", { checks: CHECKS });
  expect(() => loadCases(path.join(box.root, "cases"))).toThrow(
    /case lonely: no prompt source; add a prompt\.md/,
  );
});

test("the 0.0.1 glob still selects flat ids, and a glob can name several levels", () => {
  const box = sandbox();
  for (const id of ["rest-a", "rest-b", "other"]) plant(box, id);
  const dir = plant(box, "deep/rest-c");
  expect(idsIn(dir, "rest*")).toEqual(["rest-a", "rest-b"]);
  expect(idsIn(dir, "**/rest*")).toEqual(["deep/rest-c", "rest-a", "rest-b"]);
  expect(idsIn(dir, "*")).toEqual(["other", "rest-a", "rest-b"]);
  // In 0.0.1 a question mark was plain text. Now it is a one-character wildcard.
  expect(idsIn(dir, "rest-?")).toEqual(["rest-a", "rest-b"]);
  expect(() => loadCases(dir, "nope*")).toThrow(
    /no case in .* matches "nope\*"/,
  );
});

test("the new keys load, and each bad value is a load error that names it", () => {
  const box = sandbox();
  const dir = plant(box, "full", {
    tags: ["smoke", "routing-2"],
    description: "What it shows.",
    targets: ["bro"],
    kind: "trigger",
    expected: "loads bro",
    guard: true,
    reps: 2,
    model: "m",
    judgeModel: "j",
    env: { CASE_NAME: "x", TZ: "UTC", LANG: "C", LC_ALL: "C" },
    minDelta: -0.2,
  });
  const [loaded] = loadCases(dir);
  expect(loaded).toMatchObject({
    tags: ["smoke", "routing-2"],
    description: "What it shows.",
    targets: ["bro"],
    kind: "trigger",
    expected: "loads bro",
    guard: true,
    reps: 2,
    model: "m",
    judgeModel: "j",
    env: { CASE_NAME: "x", TZ: "UTC", LANG: "C", LC_ALL: "C" },
    minDelta: -0.2,
  });
  const bare = sandbox();
  expect(loadCases(plant(bare, "plain"))[0]).toMatchObject({
    tags: [],
    targets: [],
    guard: false,
    env: {},
  });

  const bad: [Record<string, unknown>, RegExp][] = [
    [{ tags: ["Smoke"] }, /"tags" must be a list of tags/],
    [{ tags: ["-a"] }, /"tags" must be a list of tags/],
    [{ tags: "smoke" }, /"tags" must be a list of tags/],
    [{ guard: "yes" }, /guard must be true or false/],
    [{ reps: 0 }, /reps must be a positive integer/],
    [{ targets: [] }, /"targets" must be a non-empty list/],
    [{ env: { PATH: "x" } }, /env cannot set "PATH"/],
    [{ env: { CASE_A: 1 } }, /env "CASE_A" must be a string/],
    [{ env: ["CASE_A"] }, /"env" must be an object/],
    [{ env: { "CASE_A=": "x" } }, /env cannot set "CASE_A=": has an `=`/],
    [{ env: { CASE_A: "a\0b" } }, /"CASE_A" must be a string without a NUL/],
    [{ minDelta: -1.5 }, /minDelta must be a number from -1 to 1/],
    [{ minDelta: 1.5 }, /minDelta must be a number from -1 to 1/],
  ];
  for (const [more, message] of bad) {
    const one = sandbox();
    expect(() => loadCases(plant(one, "bad", more))).toThrow(message);
  }
});
