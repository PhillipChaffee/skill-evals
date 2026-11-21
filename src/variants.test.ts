import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { plant } from "./testing/nested.js";
import type { Sandbox } from "./testing/sandbox.js";
import { readResults, sandbox, seenBy, tableRow } from "./testing/sandbox.js";

const TONE = "tone";
const POLITE = "tone@polite";
const PUSHY = "tone@pushy";
const PUSHY_PROMPT = "JUST DO IT";
const USAGE_ERROR = 2;

/**
 * Plants the case that most tests here use: one paraphrase and one pressure variant over one fixture.
 * @param box - The sandbox.
 * @returns The cases directory.
 */
const planted = (box: Sandbox): string =>
  plant(box, TONE, {
    variants: [
      { id: "polite", promptAppend: "Please be polite." },
      { id: "pushy", prompt: PUSHY_PROMPT, tags: ["pressure"] },
    ],
    tags: ["core"],
  });

/**
 * Runs a command on the planted cases.
 * @param box - The sandbox.
 * @param command - `list` or `score`.
 * @param flags - More flags.
 * @returns The command's result.
 */
const cli = (box: Sandbox, command: string, ...flags: string[]) =>
  box.cli([
    command,
    ...(command === "score" ? ["--subject", "none", "--reps", "1"] : []),
    "--cases",
    path.join(box.root, "cases"),
    ...flags,
  ]);

const listed = (stdout: string): string[] =>
  [...stdout.matchAll(/^- (.+): \d+ checks$/gm)].map((match) => match[1] ?? "");

test("a variant is addressable as id@variant and appends to the prompt", async () => {
  const box = sandbox();
  planted(box);
  expect(listed((await cli(box, "list")).stdout)).toEqual([POLITE, PUSHY]);
  const outDir = path.join(box.root, "results");
  const scored = await cli(box, "score", "--out", outDir);
  expect(scored.status, scored.stderr).toBe(0);
  const { records } = readResults(outDir);
  const promptOf = (id: string) =>
    seenBy(records.find((one) => one.caseId === id)?.finalText ?? "").prompt;
  expect(promptOf(POLITE).endsWith("do it\n\nPlease be polite.")).toBe(true);
  expect(promptOf(PUSHY)).toBe(PUSHY_PROMPT);
  expect(records.map((one) => one.caseId)).not.toContain(TONE);
  const only = await cli(box, "list", "--case", POLITE);
  expect(listed(only.stdout)).toEqual([POLITE]);
  expect(listed((await cli(box, "list", "--case", TONE)).stdout)).toEqual([
    POLITE,
    PUSHY,
  ]);
  expect(
    listed((await cli(box, "list", "--not-case", "**@pushy")).stdout),
  ).toEqual([POLITE]);
});

test("a variant's tags are added to the case's tags, and tag filters see the merged tags", async () => {
  const box = sandbox();
  planted(box);
  const tagged = (...flags: string[]) =>
    cli(box, "list", ...flags).then((result) => listed(result.stdout));
  expect(await tagged("--tag", "pressure")).toEqual([PUSHY]);
  expect(await tagged("--tag-all", "core,pressure")).toEqual([PUSHY]);
  expect(await tagged("--not-tag", "pressure")).toEqual([POLITE]);
  const [, pushy] = loadCases(path.join(box.root, "cases"));
  expect(pushy?.tags).toEqual(["core", "pressure"]);
  expect(pushy).toMatchObject({ base: TONE, variant: "pushy", heldout: false });
});

test("held-out variants run only with --heldout, and results record where each case came from", async () => {
  const box = sandbox();
  plant(box, TONE, {
    targets: ["writer"],
    variants: [
      { id: "dev", prompt: "dev prompt" },
      { id: "secret", prompt: "secret prompt", heldout: true },
    ],
  });
  plant(box, "only-held", {
    variants: [{ id: "a", prompt: "x", heldout: true }],
  });
  expect(listed((await cli(box, "list")).stdout)).toEqual(["tone@dev"]);
  const all = await cli(box, "list", "--heldout", "--targets");
  expect(listed(all.stdout)).toEqual([
    "only-held@a",
    "tone@dev",
    "tone@secret",
  ]);
  expect(tableRow(all.stdout, "writer")).toBe("| writer | 2 | 1 | 1 | 0 |");
  const hidden = await cli(box, "list", "--case", "only-held");
  expect(hidden.status).toBe(USAGE_ERROR);
  expect(hidden.stderr).toContain("no case in");
  const outDir = path.join(box.root, "results");
  const run = await cli(box, "score", "--heldout", "--out", outDir);
  expect(run.status, run.stderr).toBe(0);
  const { caseMeta } = readResults(outDir);
  expect(caseMeta["tone@secret"]).toMatchObject({
    base: TONE,
    variant: "secret",
    heldout: true,
  });
  expect(caseMeta["tone@dev"]).toMatchObject({ heldout: false });
  const plain = path.join(box.root, "plain");
  await cli(box, "score", "--out", plain);
  expect(Object.keys(readResults(plain).caseMeta)).toEqual(["tone@dev"]);
});

test("a case without variants has base = id, variant null, heldout false", async () => {
  const box = sandbox();
  plant(box, "plain");
  const outDir = path.join(box.root, "results");
  await cli(box, "score", "--out", outDir);
  expect(readResults(outDir).caseMeta["plain"]).toMatchObject({
    base: "plain",
    variant: null,
    heldout: false,
  });
});

const BAD_FILE = "ROOT/cases/bad/case.json";

/**
 * Loads a case with the given variants and reports why it failed.
 * @param variants - The `variants` key.
 * @param prompt - What prompt.md holds, or null for no file.
 * @returns The error message with the sandbox's root written as ROOT, or an empty text when the case loaded.
 */
function failure(
  variants: unknown,
  prompt: string | null = "# base\n\ntext\n",
) {
  const box = sandbox();
  box.write("cases/bad/case.json", {
    checks: [{ type: "output_contains", text: "x" }],
    ...(variants !== undefined && { variants }),
  });
  if (prompt !== null) box.write("cases/bad/prompt.md", prompt);
  try {
    loadCases(path.join(box.root, "cases"));
  } catch (error) {
    return (error as Error).message.replaceAll(box.root, "ROOT");
  }
  return "";
}

test("a variant needs exactly one prompt source, a valid unique id and known keys", () => {
  const one = `${BAD_FILE} variants[0]: a variant needs exactly one of "prompt" and "promptAppend"`;
  expect(failure([{ id: "a" }])).toBe(one);
  expect(failure([{ id: "a", prompt: "x", promptAppend: "y" }])).toBe(one);
  expect(failure([{ id: "A b", prompt: "x" }])).toBe(
    `${BAD_FILE} variants[0]: "id" must be a slug: lowercase letters, digits and hyphens, starting with a letter or digit`,
  );
  expect(
    failure([
      { id: "a", prompt: "x" },
      { id: "a", prompt: "y" },
    ]),
  ).toBe(`${BAD_FILE} variants[1]: duplicate variant id "a"`);
  expect(failure([{ id: "a", prompt: "x", color: 1 }])).toBe(
    `${BAD_FILE} variants[0]: unknown key "color" for a variant; allowed: id, prompt, promptAppend, heldout, tags`,
  );
  expect(failure([])).toBe(`${BAD_FILE}: "variants" must not be empty`);
  expect(failure("no")).toBe(
    `${BAD_FILE}: "variants" must be a list of objects`,
  );
  expect(failure([{ id: "a", prompt: "  " }])).toBe(
    `${BAD_FILE} variants[0]: prompt is empty`,
  );
  expect(failure([{ id: "a", promptAppend: "  " }])).toBe(
    `${BAD_FILE} variants[0]: promptAppend is empty`,
  );
  expect(failure([{ id: "a", heldout: "yes", prompt: "x" }])).toBe(
    `${BAD_FILE} variants[0]: heldout must be true or false`,
  );
});

test("promptAppend needs a prompt.md with text; a variant that sets prompt does not, even beside an empty one", () => {
  const needs = `${BAD_FILE} variants[0]: "promptAppend" needs a prompt.md with text to append to`;
  expect(failure([{ id: "a", promptAppend: "y" }], null)).toBe(needs);
  expect(failure([{ id: "a", promptAppend: "y" }], "")).toBe(needs);
  expect(failure([{ id: "a", prompt: "y", "x-note": 1 }], null)).toBe("");
  expect(failure([{ id: "a", prompt: "y" }], "")).toBe("");
  expect(failure(undefined, "")).toBe("case bad: prompt.md is empty");
  expect(failure(undefined, null)).toBe(
    "case bad: no prompt source; add a prompt.md",
  );
});

test('"variants" of the wrong type reports that, even with no prompt.md', () => {
  expect(failure("no", null)).toBe(
    `${BAD_FILE}: "variants" must be a list of objects`,
  );
});

test("a variant tag that repeats a case tag is listed once", () => {
  const box = sandbox();
  plant(box, TONE, {
    tags: ["core", "pressure"],
    variants: [{ id: "a", prompt: "p", tags: ["pressure", "extra"] }],
  });
  const [only] = loadCases(path.join(box.root, "cases"));
  expect(only?.tags).toEqual(["core", "pressure", "extra"]);
});

test("a held-out variant of a guard case counts under guards, not held-out", async () => {
  const box = sandbox();
  plant(box, TONE, {
    targets: ["writer"],
    guard: true,
    variants: [
      { id: "dev", prompt: "p" },
      { id: "secret", prompt: "q", heldout: true },
    ],
  });
  plant(box, "other", {
    targets: ["writer"],
    variants: [{ id: "h", prompt: "x", heldout: true }],
  });
  const out = await cli(box, "list", "--heldout", "--targets");
  expect(tableRow(out.stdout, "writer")).toBe("| writer | 3 | 0 | 1 | 2 |");
});

test("a broken case beside the selected variant does not fail --case id@variant", async () => {
  const box = sandbox();
  plant(box, "good", {
    variants: [
      { id: "v1", prompt: "a" },
      { id: "v2", prompt: "b" },
    ],
  });
  box.write("cases/broken/prompt.md", "x\n");
  box.write("cases/broken/case.json", { checks: [] });
  const one = await cli(box, "list", "--case", "good@v1");
  expect(one.status, one.stderr).toBe(0);
  expect(listed(one.stdout)).toEqual(["good@v1"]);
  expect(loadCases(path.join(box.root, "cases"), "good@v2")).toHaveLength(1);
  const wide = await cli(box, "list", "--case", "**@v1");
  expect(wide.status).toBe(USAGE_ERROR);
});

test("a variant run writes its files under <out>/<harness>/<case>@<variant>/", async () => {
  const box = sandbox();
  planted(box);
  const outDir = path.join(box.root, "results");
  await cli(box, "score", "--out", outDir);
  expect(
    fs.existsSync(
      path.join(outDir, "claude-code/tone@polite/subject1.final.md"),
    ),
  ).toBe(true);
  expect(fs.existsSync(path.join(outDir, "claude-code/tone"))).toBe(false);
});

test("a wildcard glob that only a variant id matches still selects it, and reads variant cases it must", async () => {
  const box = sandbox();
  plant(box, "tool", { variants: [{ id: "lite", prompt: "a" }] });
  plant(box, "other");
  box.write("cases/broken/prompt.md", "x\n");
  box.write("cases/broken/case.json", { checks: [] });
  const found = await cli(box, "list", "--case", "to*lite");
  expect(found.status, found.stderr).toBe(0);
  expect(listed(found.stdout)).toEqual(["tool@lite"]);
  box.write("cases/risky/prompt.md", "x\n");
  box.write("cases/risky/case.json", {
    checks: [],
    variants: [{ id: "q", prompt: "p" }],
  });
  const failed = await cli(box, "list", "--case", "to*lite");
  expect(failed.status).toBe(USAGE_ERROR);
  expect(failed.stderr).toContain(
    'risky/case.json: "checks" must be a non-empty array',
  );
  box.write("cases/risky/case.json", "{ not json");
  const unparsed = await cli(box, "list", "--case", "to*lite");
  expect(unparsed.status).toBe(USAGE_ERROR);
  expect(unparsed.stderr).toContain("case risky:");
});
