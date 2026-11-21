import path from "node:path";
import { expect, test } from "vitest";
import type { Case } from "./cases.js";
import { selectCases, splitList } from "./select.js";
import type { Sandbox } from "./testing/sandbox.js";
import { plant } from "./testing/nested.js";
import { sandbox, tableRow } from "./testing/sandbox.js";

const ROUTING_BUG = "routing/bug/first";
const PRESSURE_A = "pressure/a";
const PRESSURE_B = "pressure/b";
const CASE = "--case";
const NOT_CASE = "--not-case";
const ROUTING_SLOW = "routing/bug/slow-one";

/**
 * Reads what a `list` command printed.
 * @param stdout - The command's output.
 * @returns The ids of the cases it listed, in order.
 */
const listed = (stdout: string): string[] =>
  [...stdout.matchAll(/^- (.+): \d+ checks$/gm)].map((match) => match[1] ?? "");

/**
 * Lists the cases of a sandbox with extra flags.
 * @param box - The sandbox.
 * @param flags - The selection flags.
 * @returns The command's result.
 */
const list = (box: Sandbox, ...flags: string[]) =>
  box.cli(["list", "--cases", path.join(box.root, "cases"), ...flags]);

test("--tag selects either, --tag-all needs both, --not-tag removes", async () => {
  const box = sandbox();
  plant(box, "a", { tags: ["smoke"] });
  plant(box, "b", { tags: ["core", "routing"] });
  plant(box, "c", { tags: ["smoke", "routing", "slow"] });
  plant(box, "d");
  expect(listed((await list(box, "--tag", "smoke,core")).stdout)).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(
    listed((await list(box, "--tag-all", "smoke,routing")).stdout),
  ).toEqual(["c"]);
  expect(
    listed(
      (await list(box, "--tag", "smoke,core", "--not-tag", "slow")).stdout,
    ),
  ).toEqual(["a", "b"]);
  expect(listed((await list(box, "--not-tag", "smoke")).stdout)).toEqual([
    "b",
    "d",
  ]);
});

test("--case is repeatable, takes brace lists, and --not-case removes", async () => {
  const box = sandbox();
  for (const id of [
    ROUTING_BUG,
    ROUTING_SLOW,
    "routing/feature/second",
    PRESSURE_A,
    PRESSURE_B,
    "pressure/c",
    "other",
  ]) {
    plant(box, id);
  }
  const chosen = await list(
    box,
    CASE,
    "routing/**",
    CASE,
    "pressure/{a,b}",
    NOT_CASE,
    "**/slow-*",
  );
  expect(listed(chosen.stdout)).toEqual([
    PRESSURE_A,
    PRESSURE_B,
    ROUTING_BUG,
    "routing/feature/second",
  ]);
  const joined = await list(box, "--case", "pressure/{a,b},other");
  expect(listed(joined.stdout)).toEqual(["other", PRESSURE_A, PRESSURE_B]);
  const none = await list(box, "--case", "missing/**");
  expect(none.status).toBe(2);
  expect(none.stderr).toMatch(/no case in .* matches "missing\/\*\*"/);
  const several = await list(box, "--tag", "nothing", NOT_CASE, "other");
  expect(several.stderr).toMatch(
    /no case in .* matches the selection \(--not-case other --tag nothing\)/,
  );
});

test("--case on flat ids matches what it matched in 0.0.1", async () => {
  const box = sandbox();
  for (const id of ["rest-a", "rest-b", "other"]) plant(box, id);
  expect(listed((await list(box, "--case", "rest*")).stdout)).toEqual([
    "rest-a",
    "rest-b",
  ]);
  expect(listed((await list(box, "--case", "other")).stdout)).toEqual([
    "other",
  ]);
});

test("a 400-case tree is selected by two tags, and the coverage table has a row per target", async () => {
  const box = sandbox();
  const groups = ["routing", "pressure", "triggers", "negatives"];
  let expected = 0;
  for (let index = 0; index < 400; index++) {
    const group = groups[index % groups.length] ?? "routing";
    const tags = [
      ...(index % 2 === 0 ? ["core"] : []),
      ...(index % 4 === 0 ? ["routing"] : []),
      "all",
    ];
    if (tags.includes("core") && tags.includes("routing")) expected++;
    plant(box, `${group}/sub-${String(index % 7)}/case-${String(index)}`, {
      tags,
      targets: [`skill-${String(index % 3)}`],
      guard: index % 10 === 0,
    });
  }
  const result = await list(
    box,
    "--tag",
    "core",
    "--tag-all",
    "routing",
    "--targets",
  );
  expect(result.status, result.stderr).toBe(0);
  expect(listed(result.stdout)).toHaveLength(expected);
  expect(expected).toBe(100);
  expect(result.stdout).toContain(`${String(expected)} cases selected`);
  expect(result.stdout).toContain("Coverage by target skill");
  expect(result.stdout).toContain(
    "| skill | cases | dev | held-out | guards |",
  );
  for (const skill of ["skill-0", "skill-1", "skill-2"]) {
    expect(tableRow(result.stdout, skill)).toMatch(
      /^\| skill-\d \| \d+ \| \d+ \| 0 \| \d+ \|$/,
    );
  }
  const total = ["skill-0", "skill-1", "skill-2"].reduce(
    (sum, skill) => sum + Number(tableRow(result.stdout, skill).split("|")[2]),
    0,
  );
  expect(total).toBe(expected);
});

test("--targets is a switch of list only", async () => {
  const box = sandbox();
  plant(box, "a", { targets: ["bro"], guard: true });
  plant(box, "b", { targets: ["bro", "magic-mode"] });
  plant(box, "c");
  const result = await list(box, "--targets");
  expect(tableRow(result.stdout, "bro")).toBe("| bro | 2 | 1 | 0 | 1 |");
  expect(tableRow(result.stdout, "magic-mode")).toBe(
    "| magic-mode | 1 | 1 | 0 | 0 |",
  );
  const plain = await list(box);
  expect(plain.stdout).not.toContain("Coverage by target skill");
  const wrong = await box.cli(["score", "--targets"]);
  expect(wrong.status).toBe(2);
  expect(wrong.stderr).toMatch(/Unknown option '--targets'/);
});

test("splitList splits on commas outside braces and drops empty items", () => {
  expect(splitList(["a,b", " c ", "{x,y}/z,w", ",,"])).toEqual([
    "a",
    "b",
    "c",
    "{x,y}/z",
    "w",
  ]);
});

test("selectCases combines every part, and no part selects everything", () => {
  const make = (id: string, tags: string[]): Case =>
    ({ id, base: id, heldout: false, tags }) as unknown as Case;
  const cases = [make("a/x", ["p"]), make("a/y", ["p", "q"]), make("b", [])];
  expect(selectCases(cases, {}).map((c) => c.id)).toEqual(["a/x", "a/y", "b"]);
  expect(
    selectCases(cases, { ids: ["a/**"], tagsAll: ["p", "q"] }).map((c) => c.id),
  ).toEqual(["a/y"]);
  expect(
    selectCases(cases, { notIds: ["a/x"], notTags: ["q"] }).map((c) => c.id),
  ).toEqual(["b"]);
});

test("every list flag may be repeated, and an empty list is a usage error", async () => {
  const box = sandbox();
  plant(box, "a", { tags: ["x", "y"] });
  plant(box, "b", { tags: ["x"] });
  plant(box, "c", { tags: ["y"] });
  plant(box, "d");
  expect(
    listed((await list(box, NOT_CASE, "a", NOT_CASE, "b")).stdout),
  ).toEqual(["c", "d"]);
  expect(
    listed((await list(box, "--tag-all", "x", "--tag-all", "y")).stdout),
  ).toEqual(["a"]);
  expect(
    listed((await list(box, "--not-tag", "x", "--not-tag", "y")).stdout),
  ).toEqual(["d"]);
  for (const flag of ["--case", "--tag", "--not-tag"]) {
    for (const value of ["", ","]) {
      const bad = await list(box, flag, value);
      expect(bad.status).toBe(2);
      expect(bad.stderr).toContain(`${flag} needs at least one value`);
    }
  }
});
