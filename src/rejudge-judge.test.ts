import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { EXIT } from "./exit-codes.js";
import { CONFIG_FILE } from "./project.js";
import { choice, decisionServer, yesNo } from "./testing/decision-server.js";
import { PASS } from "./testing/judged.js";
import { plantCase, plugin } from "./testing/plant.js";
import {
  FIXED,
  REJUDGED,
  judged,
  onlyRecord,
  promptsOf,
  resultsIn,
  scoredWith,
} from "./testing/rejudge.js";
import { sandbox } from "./testing/sandbox.js";
import { startsOf } from "./testing/suite.js";

const CLAUDE = "claude-code";
const RUBRIC = "It names the fix.";
const DIFFERS = "the judge differs";
const STORED = "results/results.json";

test("the recorded decision model serves both the cache key and the request, whatever the config says", async () => {
  const box = sandbox();
  const server = await decisionServer([
    { answers: { q1: yesNo(0.9), q2: choice({ a: 1 }) } },
  ]);
  const owned = plugin(box, "plugin-owned", { answer: "It is fixed now." });
  box.write(CONFIG_FILE, {
    env: ["BASETEN_API_KEY"],
    decisionModel: "other-model",
    decisionUrl: server.url,
  });
  const question = (text: string) => ({
    type: "decision",
    question: text,
    expect: "yes",
  });
  const cases = plantCase(box, [question("Is it plain?")]);
  const out = path.join(box.root, "results");
  const env = { BASETEN_API_KEY: "skill-evals-decision-key" };
  await box.cli(
    [
      ...["score", "--subject", owned, "--cases", cases, "--reps", "1"],
      ...["--out", out, "--decision-model", "decider"],
    ],
    env,
  );
  const hit = await box.cli(["rejudge", out, "--cases", cases], env);
  expect(hit.status, hit.stderr).toBe(EXIT.ok);
  expect(server.received).toHaveLength(1);
  box.write("cases/restate/case.json", { checks: [question("Is it clear?")] });
  const miss = await box.cli(
    ["rejudge", out, "--cases", cases, "--out", `${out}-b`],
    env,
  );
  expect(miss.status, miss.stderr).toBe(EXIT.ok);
  expect(server.received).toHaveLength(2);
  expect(server.received[1]?.body.model).toBe("decider");
});

test("a source scored with --lenient is rejudged with it, cases included", async () => {
  const scored = await scoredWith([FIXED], {
    flags: ["--lenient"],
    extra: { "unknown-key": 1 },
  });
  const ran = await scored.rejudge();
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  const strict = await scored.rejudge(["--out", `${scored.out}-s`]);
  expect(strict.status, strict.stderr).toBe(EXIT.ok);
});

test("a source judged by a named harness is rejudged by it, recorded or parsed", async () => {
  const scored = await scoredWith([judged(RUBRIC)], {
    replies: [PASS],
    flags: ["--judge-harness", CLAUDE, "--judge-model", "judge-one"],
  });
  expect(resultsIn(scored.out).meta.judge).toMatchObject({
    via: "harness",
    harness: CLAUDE,
  });
  const before = startsOf(scored.box);
  const ran = await scored.rejudge();
  expect(ran.stderr).not.toContain(DIFFERS);
  expect(startsOf(scored.box)).toBe(before);
  const stored = resultsIn(scored.out);
  scored.box.write(STORED, {
    ...stored,
    meta: { ...stored.meta, judge: undefined },
  });
  const old = await scored.rejudge();
  expect(old.stderr).not.toContain(DIFFERS);
  expect(startsOf(scored.box)).toBe(before);
  expect(onlyRecord(scored.out, REJUDGED).judge).toMatchObject({
    cacheHits: 1,
  });
});

test("naming the harness under test as the judge is no change, and keeps the recorded model", async () => {
  const scored = await scoredWith([judged(RUBRIC)], {
    replies: [PASS],
    flags: ["--judge-model", "judge-one"],
  });
  const before = startsOf(scored.box);
  const ran = await scored.rejudge(["--judge-harness", CLAUDE]);
  expect(ran.stderr).not.toContain(DIFFERS);
  expect(startsOf(scored.box)).toBe(before);
  expect(promptsOf(scored.box.root)).toBe(1);
});

test("--out is checked after the source lock, and nothing is created when the source is busy", async () => {
  const scored = await scoredWith([FIXED]);
  const other = path.join(scored.box.root, "fresh");
  fs.writeFileSync(
    path.join(scored.out, ".lock"),
    JSON.stringify({ pid: process.pid, hostname: "elsewhere" }),
  );
  const ran = await scored.rejudge(["--out", other]);
  expect(ran.status).toBe(EXIT.usage);
  expect(fs.existsSync(other)).toBe(false);
});

test("the source lock is released when --out cannot be locked", async () => {
  const scored = await scoredWith([FIXED]);
  const busy = path.join(scored.box.root, "busy");
  fs.mkdirSync(busy);
  fs.writeFileSync(
    path.join(busy, ".lock"),
    JSON.stringify({ pid: process.pid, hostname: "elsewhere" }),
  );
  const ran = await scored.rejudge(["--out", busy]);
  expect(ran.status).toBe(EXIT.usage);
  expect(fs.existsSync(path.join(scored.out, ".lock"))).toBe(false);
});

test("--out inside the directory being re-judged is a usage error", async () => {
  const scored = await scoredWith([FIXED]);
  const ran = await scored.rejudge(["--out", path.join(scored.out, "sub")]);
  expect(ran.status).toBe(EXIT.usage);
  expect(ran.stderr).toContain("is inside the directory being re-judged");
});
