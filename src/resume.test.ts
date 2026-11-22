import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { readResults, sandbox } from "./testing/sandbox.js";
import type { Sandbox } from "./testing/sandbox.js";
import { keepStarts, linesIn, plantSuite, startsOf } from "./testing/suite.js";

const ids = ["alpha", "bravo", "charlie", "delta"];
const JUDGE_ONE = "judge-one";
const RUNS = "results.jsonl";
const JUDGE_FLAG = "--judge-model";

/**
 * Plants a suite.
 * @param box - The sandbox.
 * @param names - The case ids.
 * @returns The cases directory, the output directory, and the commands that score the suite fresh and resumed into it.
 */
function suite(box: Sandbox, names = ids) {
  const cases = plantSuite(box, names);
  const out = path.join(box.root, "results");
  const base = ["--subject", "none", "--cases", cases, "--reps", "1"];
  return {
    cases,
    out,
    fresh: (...more: string[]) =>
      box.cli(["score", ...base, "--out", out, ...more]),
    resume: (...more: string[]) =>
      box.cli(["score", ...base, "--resume", out, ...more]),
  };
}

test("an interrupted run resumes without repeating finished runs", async () => {
  const box = sandbox();
  const { out, fresh, resume } = suite(box);
  const first = await fresh();
  expect(first.status, first.stderr).toBe(0);
  // The interruption: the command died after two runs, before it wrote anything else.
  const kept = linesIn(out).slice(0, 2);
  fs.writeFileSync(path.join(out, RUNS), `${kept.join("\n")}\n`);
  fs.rmSync(path.join(out, "results.json"));
  keepStarts(box, 2);

  const second = await resume();
  expect(second.status, second.stderr).toBe(0);
  expect(startsOf(box)).toBe(ids.length);
  expect(second.stderr.match(/\(reused\)/g)).toHaveLength(2);
  const { records } = readResults(out);
  expect(records.map((record) => record.caseId)).toEqual(ids);
  expect(records.every((record) => record.score === 1)).toBe(true);
  expect(linesIn(out)).toHaveLength(ids.length);
});

test("a second resume repeats nothing", async () => {
  const box = sandbox();
  const { fresh, resume } = suite(box);
  await fresh();
  const again = await resume();
  expect(again.status, again.stderr).toBe(0);
  expect(startsOf(box)).toBe(ids.length);
  expect(again.stderr.match(/\(reused\)/g)).toHaveLength(ids.length);
});

test("a changed case file is re-run on resume", async () => {
  const box = sandbox();
  const { out, fresh, resume } = suite(box);
  await fresh();
  fs.writeFileSync(
    path.join(box.root, "suite/bravo/prompt.md"),
    "say it again\n",
  );
  const again = await resume();
  expect(again.status, again.stderr).toBe(0);
  expect(startsOf(box)).toBe(ids.length + 1);
  expect(again.stderr.match(/\(reused\)/g)).toHaveLength(ids.length - 1);
  // The old line stays; the new run is added after it.
  expect(linesIn(out)).toHaveLength(ids.length + 1);
  const bravo = readResults(out).records.find(
    (record) => record.caseId === "bravo",
  );
  expect(bravo?.score).toBe(1);
});

test("a changed file beside the case is re-run too", async () => {
  const box = sandbox();
  const { fresh, resume } = suite(box);
  await fresh();
  box.write("suite/delta/grader/check.sh", "exit 0\n");
  await resume();
  expect(startsOf(box)).toBe(ids.length + 1);
});

test("a truncated last line is dropped and its run repeats", async () => {
  const box = sandbox();
  const { out, fresh, resume } = suite(box);
  await fresh();
  const file = path.join(out, RUNS);
  const text = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, text.slice(0, text.length - 40));
  const again = await resume();
  expect(again.status, again.stderr).toBe(0);
  expect(again.stderr.match(/is not valid JSON/g)).toHaveLength(1);
  expect(startsOf(box)).toBe(ids.length + 1);
  // The broken text is gone, so the new line starts on a line of its own.
  const lines = linesIn(out);
  expect(lines).toHaveLength(ids.length);
  for (const line of lines) {
    expect(() => {
      JSON.parse(line);
    }).not.toThrow();
  }
  expect(readResults(out).records).toHaveLength(ids.length);
});

test("a last line that lacks only its newline is kept and the next line starts apart", async () => {
  const box = sandbox();
  const { out, fresh, resume } = suite(box, ["alpha", "bravo"]);
  await fresh();
  const file = path.join(out, RUNS);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").trimEnd());
  const again = await resume();
  expect(again.status, again.stderr).toBe(0);
  expect(again.stderr).not.toContain("not valid JSON");
  expect(startsOf(box)).toBe(2);
  expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
});

test("a damaged line before the last is a usage error that names its number", async () => {
  const box = sandbox();
  const { out, fresh, resume } = suite(box);
  await fresh();
  const file = path.join(out, RUNS);
  const lines = linesIn(out);
  lines[1] = "{not json";
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  const again = await resume();
  expect(again.status).toBe(2);
  expect(again.stderr).toMatch(
    /results\.jsonl: line 2 is not a valid run record/,
  );
  expect(startsOf(box)).toBe(ids.length);
});

test("an invalid record is re-run on resume", async () => {
  const box = sandbox();
  const { out, fresh, resume } = suite(box);
  await fresh();
  const file = path.join(out, RUNS);
  const lines = linesIn(out).map((line, index) =>
    index === 2
      ? JSON.stringify({
          ...(JSON.parse(line) as object),
          error: "harness crashed",
          ok: false,
          score: null,
        })
      : line,
  );
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  const again = await resume();
  expect(again.status, again.stderr).toBe(0);
  expect(startsOf(box)).toBe(ids.length + 1);
  const { records } = readResults(out);
  expect(records.every((record) => record.score === 1)).toBe(true);
  expect(linesIn(out)).toHaveLength(ids.length + 1);
});

test("changing the judge model re-runs", async () => {
  const box = sandbox();
  const { fresh, resume } = suite(box, ["alpha", "bravo"]);
  await fresh(JUDGE_FLAG, JUDGE_ONE);
  await resume(JUDGE_FLAG, JUDGE_ONE);
  expect(startsOf(box)).toBe(2);
  await resume(JUDGE_FLAG, "judge-two");
  expect(startsOf(box)).toBe(4);
});

test("changing the model or the lenient mode re-runs", async () => {
  const box = sandbox();
  const { fresh, resume } = suite(box, ["alpha"]);
  await fresh("--model", "m1");
  await resume("--model", "m2");
  expect(startsOf(box)).toBe(2);
  await resume("--model", "m2", "--lenient");
  expect(startsOf(box)).toBe(3);
});

test("a different subject content re-runs, and the same content is reused", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  box.write("kit/one/SKILL.md", "first\n");
  const out = path.join(box.root, "results");
  const args = (more: string[]) => [
    ...["score", "--subject", path.join(box.root, "kit"), "--cases", cases],
    ...["--reps", "1", ...more],
  ];
  await box.cli([...args(["--out", out])]);
  await box.cli(args(["--resume", out]));
  expect(startsOf(box)).toBe(1);
  box.write("kit/one/SKILL.md", "second\n");
  await box.cli(args(["--resume", out]));
  expect(startsOf(box)).toBe(2);
});

test("--resume with a different --out is a usage error", async () => {
  const box = sandbox();
  const { out, fresh, cases } = suite(box);
  await fresh();
  const ran = await box.cli([
    ...["score", "--subject", "none", "--cases", cases],
    ...["--resume", out, "--out", path.join(box.root, "elsewhere")],
  ]);
  expect(ran.status).toBe(2);
  expect(ran.stderr).toMatch(/--resume .* implies --out/);
  expect(startsOf(box)).toBe(ids.length);
  // The same directory, spelled both ways, is fine.
  const same = await box.cli([
    ...["score", "--subject", "none", "--cases", cases, "--reps", "1"],
    ...["--resume", out, "--out", `${out}/../results`],
  ]);
  expect(same.status, same.stderr).toBe(0);
});

test("--resume on a directory with no results.jsonl is a usage error", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  fs.mkdirSync(path.join(box.root, "empty"));
  const ran = await box.cli([
    ...["score", "--subject", "none", "--cases", cases],
    ...["--resume", path.join(box.root, "empty")],
  ]);
  expect(ran.status).toBe(2);
  expect(ran.stderr).toMatch(/there is no results\.jsonl in it/);
  expect(startsOf(box)).toBe(0);
});

test("keys that the plan lacks stay in results.jsonl and are left out of results.json", async () => {
  const box = sandbox();
  const { out, fresh, resume } = suite(box);
  await fresh();
  const narrow = await resume("--case", "alpha,bravo");
  expect(narrow.status, narrow.stderr).toBe(0);
  expect(readResults(out).records.map((record) => record.caseId)).toEqual([
    "alpha",
    "bravo",
  ]);
  expect(linesIn(out)).toHaveLength(ids.length);
  // A later resume of the whole suite finds the other two again.
  await resume();
  expect(startsOf(box)).toBe(ids.length);
  expect(readResults(out).records).toHaveLength(ids.length);
});

test("a reused record keeps its transcript file", async () => {
  const box = sandbox();
  const { out, fresh, resume } = suite(box, ["alpha"]);
  await fresh();
  const before = readResults(out).records[0]?.transcriptFile;
  await resume();
  const after = readResults(out).records[0]?.transcriptFile;
  expect(after).toBe(before);
  expect(fs.existsSync(path.join(out, String(after)))).toBe(true);
});

test("two subjects with the same content each keep their own records on resume", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  const out = path.join(box.root, "results");
  const base = [
    "run",
    "--a",
    "none",
    "--b",
    "none",
    "--cases",
    cases,
    "--reps",
    "1",
  ];
  await box.cli([...base, "--out", out]);
  const again = await box.cli([...base, "--resume", out]);
  expect(again.status, again.stderr).toBe(0);
  expect(startsOf(box)).toBe(2);
  expect(readResults(out).records.map((record) => record.subject)).toEqual([
    "a",
    "b",
  ]);
});
