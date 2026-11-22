import { expect, test } from "vitest";
import { scanCase, scanCases } from "./blinding-case.js";
import { scanRuntime } from "./blinding-runtime.js";
import { loadCases } from "./cases.js";
import { DEFAULT_BLINDING_WORDS, textHits, unblindedOf } from "./blinding.js";
import { referencePages } from "./docs/reference.js";
import { childEnv } from "./env.js";
import { CONFIG_FILE } from "./project.js";
import { TEMP_PREFIXES } from "./scope.js";
import { plantBlind as plant, validated } from "./testing/blinding.js";
import { sandbox } from "./testing/sandbox.js";

const USAGE_ERROR = 2;
const WRITE_TEST = "write a test for it\n";
const CLEAN = ["1 cases, 0 problems, 0 warnings"];

test('a prompt with "benchmark" warns', async () => {
  const box = sandbox();
  plant(box, "c", { prompt: "Run the Benchmark and report\n" });
  const { status, lines } = await validated(box);
  expect(status).toBe(0);
  expect(lines[0]).toMatch(
    /^warning c: the prompt holds "benchmark", which may tell the agent that it is being evaluated$/,
  );
  expect(lines.at(-1)).toBe("1 cases, 0 problems, 1 warnings");
});

test("x-unblinded with a why silences it and without a why is a load error", async () => {
  const box = sandbox();
  const words = ["test"];
  plant(box, "ok", {
    prompt: WRITE_TEST,
    file: { "x-unblinded": { words, why: "the task is to write tests" } },
  });
  plant(box, "bare", {
    prompt: WRITE_TEST,
    file: { "x-unblinded": { words } },
  });
  plant(box, "blank", {
    prompt: WRITE_TEST,
    file: { "x-unblinded": { words, why: "  " } },
  });
  // Under --lenient too: this is not an unknown key.
  const { status, lines } = await validated(box, ["--lenient"]);
  expect(status).toBe(USAGE_ERROR);
  expect(lines.filter((line) => line.startsWith("problem "))).toHaveLength(2);
  expect(lines.join("\n")).toMatch(/problem bare: .*needs a non-empty "why"/);
  expect(lines.join("\n")).toMatch(/problem blank: .*needs a non-empty "why"/);
  expect(lines.join("\n")).not.toContain("warning ok");
  // The words it lists are the only ones it silences.
  plant(box, "narrow", {
    prompt: "write a test and a benchmark\n",
    file: { "x-unblinded": { words, why: "tests are the task" } },
  });
  const again = await validated(box, ["--lenient", "--case", "narrow"]);
  expect(again.lines[0]).toMatch(/warning narrow: .*"benchmark"/);
  expect(again.lines.join("\n")).not.toContain('"test"');
});

test("x-unblinded of a variant is checked, and a malformed one is a load error", async () => {
  const box = sandbox();
  plant(box, "v", {
    file: {
      variants: [
        { id: "a", promptAppend: "more", "x-unblinded": { words: ["test"] } },
      ],
    },
  });
  plant(box, "shape", { file: { "x-unblinded": "test" } });
  plant(box, "list", { file: { "x-unblinded": { why: "w", words: "test" } } });
  plant(box, "upper", {
    file: { "x-unblinded": { why: "w", words: ["Test"] } },
  });
  const { status, lines } = await validated(box);
  expect(status).toBe(USAGE_ERROR);
  expect(lines.join("\n")).toMatch(/problem v: .*needs a non-empty "why"/);
  expect(lines.join("\n")).toMatch(/problem shape: .*must be an object/);
  expect(lines.join("\n")).toMatch(/problem list: .*needs "words"/);
  expect(lines.join("\n")).toMatch(/problem upper: .*lowercase/);
});

test("a word inside another word is not flagged, and the endings are", () => {
  const roots = DEFAULT_BLINDING_WORDS;
  for (const text of ["enter the contest", "the latest news", "attestation"]) {
    expect(textHits(text, ["test"]), text).toEqual([]);
  }
  expect(textHits("a retest", ["test"])).toEqual([]);
  for (const text of ["a test", "Tests", "tested", "testing", "a tester"]) {
    expect(textHits(text, ["test"]), text).toEqual(["test"]);
  }
  expect(textHits("test-driven, eval.js", ["test", "eval"])).toEqual([
    "test",
    "eval",
  ]);
  // Letter boundaries: "_", digits, dots and a change of case end a word.
  for (const text of [
    "Fix test_parse in run_tests.py",
    "eval_results",
    "RunTest",
    "test2",
    "src/my_test-file.TS",
  ]) {
    expect(textHits(text, ["test", "eval"]).length, text).toBeGreaterThan(0);
  }
  // Roots with endings.
  for (const word of [
    "evaluate",
    "evaluation",
    "evaluator",
    "evaluated",
    "judging",
    "judged",
    "judgement",
    "judgements",
    "comparison",
    "comparisons",
    "judgment",
    "scored",
    "scoring",
    "compared",
    "comparing",
    "experimental",
    "candidates",
    "benchmarking",
  ]) {
    expect(textHits(word, roots).length, word).toBeGreaterThan(0);
  }
  // Words of any script are fine, and match as letters.
  expect(textHits("une évaluation", ["évaluation"])).toEqual(["évaluation"]);
  expect(textHits("テスト", ["テスト"])).toEqual(["テスト"]);
  expect(textHits("a scoreboard, a candidacy", roots)).toEqual([]);
});

test("a prompt that holds only a word inside another word is not flagged by validate", async () => {
  const box = sandbox();
  plant(box, "c", { prompt: "enter the contest\n" });
  const { lines } = await validated(box);
  expect(lines).toEqual(CLEAN);
});

test("subject skill names are exempt", async () => {
  const box = sandbox();
  plant(box, "route", { file: { targets: ["arena"] } });
  const { lines } = await validated(box, [], {
    arena: "# arena\nUse for tests and benchmarks.\n",
  });
  expect(lines).toEqual(CLEAN);
});

test("blindingWords replaces the default list, and a bad entry is a usage error", async () => {
  const box = sandbox();
  box.write(CONFIG_FILE, { blindingWords: ["contest"] });
  plant(box, "c", { prompt: "the benchmark and the contest\n" });
  const { lines } = await validated(box);
  expect(lines[0]).toMatch(/^warning c: the prompt holds "contest"/);
  expect(lines).toHaveLength(2);

  for (const bad of [[""], ["Test"], ["c++"], ["two words"], ["1st"]]) {
    const other = sandbox();
    other.write(CONFIG_FILE, { blindingWords: bad });
    plant(other, "c");
    const ran = await other.cli(["validate", "--subject", "none"]);
    expect(ran.status, JSON.stringify(bad)).toBe(USAGE_ERROR);
    expect(ran.stderr).toContain(
      '"blindingWords" needs lowercase words of letters, digits and hyphens',
    );
  }
  const empty = sandbox();
  empty.write(CONFIG_FILE, { blindingWords: [] });
  plant(empty, "c", { prompt: "the benchmark\n" });
  const { lines: none } = await validated(empty);
  expect(none[0]).toContain("note: blindingWords is empty");
  expect(none).toHaveLength(2);
});

test("the tool's own temp names, and the names it sets, hold no default word", () => {
  expect(scanRuntime([...TEMP_PREFIXES], [], DEFAULT_BLINDING_WORDS)).toEqual(
    [],
  );
  const env = childEnv({
    home: "/home",
    base: {
      PATH: "/bin",
      TMPDIR: "/tmp",
      LC_ALL: "C",
      SSL_CERT_FILE: "/c",
      HTTPS_PROXY: "p",
    },
    harnessEnv: {},
    authEnv: [],
    pass: [],
    withhold: [],
  });
  expect(
    scanRuntime(["/tmp"], Object.keys(env), DEFAULT_BLINDING_WORDS),
  ).toEqual([]);
  expect(scanRuntime(["/tmp/eval-x"], ["MY_JUDGE"], ["eval", "judge"])).toEqual(
    [
      'the path "/tmp/eval-x" holds "eval"',
      'the variable name MY_JUDGE holds "judge"',
    ],
  );
});

test("the default list is in the config reference", () => {
  const page =
    referencePages().find(({ file }) => file === "reference/config.md")
      ?.markdown ?? "";
  for (const word of DEFAULT_BLINDING_WORDS) {
    expect(page).toContain(`\`${word}\``);
  }
  expect(page).toContain("`blindingWords`");
});

test("unblindedOf reads a valid key, and nothing for an absent or invalid one", () => {
  const given = { "x-unblinded": { words: ["test"], why: "because" } };
  expect(unblindedOf(given)).toEqual({ words: ["test"], why: "because" });
  expect(unblindedOf({})).toBeNull();
  expect(unblindedOf({ "x-unblinded": { words: ["test"] } })).toBeNull();
});

test("scanCase looks at the paths once for a case with variants, and a variant's own x-unblinded silences its words", () => {
  const box = sandbox();
  plant(box, "v", {
    prompt: "base\n",
    file: {
      variants: [
        { id: "a", promptAppend: "run the benchmark" },
        {
          id: "b",
          promptAppend: "run the benchmark",
          "x-unblinded": { words: ["benchmark"], why: "it is the task" },
        },
      ],
    },
    files: { "workspace/benchmark.txt": "x" },
  });
  const [first, second] = loadCases(`${box.root}/cases`);
  if (!first || !second) throw new Error("two variants expected");
  const words = DEFAULT_BLINDING_WORDS;
  expect(scanCase(first, words).map(({ text }) => text)).toEqual([
    expect.stringContaining('the prompt holds "benchmark"'),
    expect.stringContaining('workspace/ holds "benchmark" in 1 path'),
  ]);
  expect(scanCase(first, words, { paths: false })).toHaveLength(1);
  expect(scanCase(second, words)).toEqual([]);
  expect(scanCases([first, second], words)).toHaveLength(2);
});
