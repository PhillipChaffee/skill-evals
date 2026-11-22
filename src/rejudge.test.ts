import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { EXIT } from "./exit-codes.js";
import { PASS } from "./testing/judged.js";
import {
  FIXED,
  KEEP,
  NEVER,
  NOTES,
  REJUDGED,
  RESULTS,
  judged,
  onlyRecord,
  promptsOf,
  read,
  resultsIn,
  scoredWith,
} from "./testing/rejudge.js";
import { startsOf } from "./testing/suite.js";

const FIX = "It names the fix.";

const JSONL = "results.jsonl";

test("a rewritten pattern is re-scored without starting the harness", async () => {
  const scored = await scoredWith([FIXED]);
  expect(onlyRecord(scored.out).checks[0]?.score).toBe(1);
  const before = startsOf(scored.box);
  scored.rewrite([NEVER]);
  const ran = await scored.rejudge();
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  expect(startsOf(scored.box)).toBe(before);
  const record = onlyRecord(scored.out, REJUDGED);
  expect(record.checks[0]?.score).toBe(0);
  expect(record.score).toBe(0);
  expect(ran.stdout).toContain("restate");
  expect(ran.stderr).toContain("(re-scored)");
});

test("a rewritten rubric with a cache miss calls only the judge", async () => {
  const scored = await scoredWith([judged(FIX)], {
    replies: [PASS, PASS, PASS],
  });
  expect(promptsOf(scored.box.root)).toBe(1);
  const before = startsOf(scored.box);
  scored.rewrite([judged("It names the fix and why.")]);
  const ran = await scored.rejudge();
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  // One more start, and it is the judge's: the agent did not run again.
  expect(promptsOf(scored.box.root)).toBe(2);
  expect(startsOf(scored.box)).toBe(before + 1);
  expect(onlyRecord(scored.out, REJUDGED).checks[0]?.score).toBe(1);
});

test("an unchanged rubric is served from the cache and starts nothing", async () => {
  const rubric = {
    type: "judge",
    rubric: FIX,
    scale: "binary",
  };
  const scored = await scoredWith([rubric], { replies: [PASS] });
  const before = startsOf(scored.box);
  const ran = await scored.rejudge();
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  expect(startsOf(scored.box)).toBe(before);
  const record = onlyRecord(scored.out, REJUDGED);
  expect(record.judge).toMatchObject({ calls: 0, cacheHits: 1 });
});

test("rejudge starts no agent harness, for a pattern, a file check or a command check", async () => {
  const scored = await scoredWith(
    [
      FIXED,
      { type: "file_exists", path: NOTES },
      { type: "command", run: "true" },
    ],
    { flags: [KEEP] },
  );
  const before = startsOf(scored.box);
  scored.rewrite([
    NEVER,
    { type: "file_exists", path: "notes.txt" },
    { type: "command", run: "test -f notes.txt" },
  ]);
  const ran = await scored.rejudge();
  await scored.rejudge(["--case", "restate"]);
  expect(startsOf(scored.box)).toBe(before);
  expect(
    onlyRecord(scored.out, REJUDGED).checks.map((one) => one.score),
  ).toEqual([0, 1, 1]);
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
});

test("rejudge leaves results.json untouched", async () => {
  const scored = await scoredWith([FIXED]);
  const files = [RESULTS, JSONL].map((name) => path.join(scored.out, name));
  const before = files.map(read);
  scored.rewrite([NEVER]);
  const ran = await scored.rejudge();
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  expect(files.map(read)).toEqual(before);
  expect(fs.existsSync(path.join(scored.out, REJUDGED))).toBe(true);
  expect(fs.existsSync(path.join(scored.out, ".lock"))).toBe(false);
});

test("--out writes the full set into another directory", async () => {
  const scored = await scoredWith([FIXED]);
  const other = path.join(scored.box.root, "again");
  scored.rewrite([NEVER]);
  const ran = await scored.rejudge(["--out", other]);
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  for (const name of [RESULTS, "summary.json"]) {
    expect(fs.existsSync(path.join(other, name))).toBe(true);
  }
  expect(onlyRecord(other).checks[0]?.score).toBe(0);
  expect(onlyRecord(scored.out).checks[0]?.score).toBe(1);
  expect(fs.existsSync(path.join(scored.out, REJUDGED))).toBe(false);
  expect(ran.stdout).toContain("restate");
});

test("--out equal to the source is a usage error", async () => {
  const scored = await scoredWith([FIXED]);
  const before = read(path.join(scored.out, RESULTS));
  const ran = await scored.rejudge(["--out", scored.out]);
  expect(ran.status).toBe(EXIT.usage);
  expect(ran.stderr).toContain("being re-judged");
  expect(read(path.join(scored.out, RESULTS))).toBe(before);
});

test("rejudge needs one output directory", async () => {
  const scored = await scoredWith([FIXED]);
  const none = await scored.box.cli(["rejudge"]);
  expect(none.status).toBe(EXIT.usage);
  expect(none.stderr).toContain("exactly <out dir>, not 0 arguments");
  const empty = await scored.box.cli(["rejudge", scored.box.root]);
  expect(empty.status).toBe(EXIT.usage);
  expect(empty.stderr).toContain(JSONL);
  const extra = await scored.box.cli(["score", "stray"]);
  expect(extra.status).toBe(EXIT.usage);
  expect(extra.stderr).toContain("takes no arguments, not 1 argument");
});

test("a changed prompt is not re-scored", async () => {
  const scored = await scoredWith([FIXED]);
  const before = startsOf(scored.box);
  scored.rewrite([NEVER]);
  scored.box.write("cases/restate/prompt.md", "say it differently\n");
  const ran = await scored.rejudge();
  expect(ran.stderr).toContain(
    "not re-scored: the case changed beyond its checks",
  );
  expect(startsOf(scored.box)).toBe(before);
  // The record is as it was: still the old check, still its old score.
  const record = onlyRecord(scored.out, REJUDGED);
  expect(record.checks[0]).toMatchObject({ pattern: "fixed", score: 1 });
});

test("a run stored before inputHash is re-scored with one warning", async () => {
  const scored = await scoredWith([FIXED]);
  const file = path.join(scored.out, RESULTS);
  const results = resultsIn(scored.out);
  for (const record of results.records) delete record.inputHash;
  fs.writeFileSync(file, JSON.stringify(results));
  scored.rewrite([NEVER]);
  const ran = await scored.rejudge();
  expect(ran.stderr.match(/no inputHash/g)).toHaveLength(1);
  expect(onlyRecord(scored.out, REJUDGED).score).toBe(0);
});

test("rejudge finishes a skippedGraders run", async () => {
  const rubric = {
    type: "judge",
    rubric: FIX,
    scale: "binary",
  };
  const scored = await scoredWith([rubric], { replies: [PASS, PASS] });
  const stored = resultsIn(scored.out);
  const [record] = stored.records;
  if (record === undefined) throw new Error("no record");
  const skipped = {
    ...record,
    score: null,
    skippedGraders: true as const,
    checks: record.checks.map((check) => ({
      ...check,
      score: null,
      reason: "skipped: budget reached",
    })),
  };
  fs.writeFileSync(
    path.join(scored.out, RESULTS),
    JSON.stringify({
      ...stored,
      records: [skipped],
      partial: { reason: "budget" },
    }),
  );
  const ran = await scored.rejudge();
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  const done = resultsIn(scored.out, REJUDGED);
  expect(done.partial).toBeNull();
  expect(done.records[0]).not.toHaveProperty("skippedGraders");
  expect(done.records[0]?.score).toBe(1);
  expect(done.notRun).toEqual([]);
});

test("rejudge refuses a directory that another command holds", async () => {
  const scored = await scoredWith([FIXED]);
  fs.writeFileSync(
    path.join(scored.out, ".lock"),
    JSON.stringify({ pid: process.pid, hostname: "elsewhere" }),
  );
  const ran = await scored.rejudge();
  expect(ran.status).toBe(EXIT.usage);
  expect(ran.stderr).toContain(".lock");
});

test("the judge of the earlier command is the default, and a flag replaces it", async () => {
  const scored = await scoredWith([judged(FIX)], {
    replies: [PASS, PASS, PASS],
    flags: ["--model", "small", "--judge-model", "judge-one"],
  });
  scored.rewrite([judged("It names the fix and why.")]);
  await scored.rejudge();
  scored.rewrite([judged("It names the fix, why and how.")]);
  await scored.rejudge(["--judge-model", "judge-two"]);
  const models = read(path.join(scored.box.root, "fake/judge/prompts.jsonl"))
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { model: string }).model);
  expect(models).toEqual(["judge-one", "judge-one", "judge-two"]);
  expect(resultsIn(scored.out, REJUDGED).meta.models).toMatchObject({
    agent: "small",
    judge: "judge-two",
  });
});

test("a run with no key in results.jsonl warns once and caches apart", async () => {
  const scored = await scoredWith([judged(FIX)], { replies: [PASS, PASS] });
  fs.writeFileSync(path.join(scored.out, JSONL), "");
  const ran = await scored.rejudge();
  expect(ran.stderr.match(/has no key in results\.jsonl/g)).toHaveLength(1);
});

test("help names each command with what it takes", async () => {
  const scored = await scoredWith([FIXED]);
  const help = await scored.box.cli(["help"]);
  expect(help.stdout).toContain("rejudge <out dir>");
  expect(help.stdout).toContain("diff <a> <b>");
});
