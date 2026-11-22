import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { EXIT } from "./exit-codes.js";
import { CONFIG_FILE } from "./project.js";
import { choice, decisionServer, yesNo } from "./testing/decision-server.js";
import { apiCase } from "./testing/judged.js";
import { reply } from "./testing/judge-server.js";
import { plantCase, plugin, script, skillsFolder } from "./testing/plant.js";
import {
  FIXED,
  NEVER,
  REJUDGED,
  RESULTS,
  onlyRecord,
  resultsIn,
  scoredWith,
} from "./testing/rejudge.js";
import { readResults, sandbox } from "./testing/sandbox.js";
import { startsOf } from "./testing/suite.js";

const ANSWER = "It is fixed now.";
const KEY = "skill-evals-judge-key";
const STORED = "results/results.json";

test("a stand-in for a case keeps the case's own minDelta", async () => {
  const box = sandbox();
  const alpha = plugin(box, "plugin-alpha", { answer: ANSWER });
  const beta = plugin(box, "plugin-beta", { answer: ANSWER });
  const cases = plantCase(box, [FIXED], { minDelta: 0.5 });
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    ...["run", "--a", alpha, "--b", beta, "--cases", cases],
    ...["--reps", "1", "--out", out],
  ]);
  expect(ran.status, ran.stderr).toBe(EXIT.bar);
  box.write("cases/restate/prompt.md", "another question\n");
  const again = await box.cli(["rejudge", out, "--cases", cases]);
  expect(again.status, again.stderr).toBe(EXIT.bar);
  expect(readResults(out).belowBar).toHaveLength(1);
});

test("a source scored through the judge API is rejudged through it, from the cache", async () => {
  const { run, out, box, received } = await apiCase(
    { rubric: "It names the fix.", scale: "binary" },
    [reply('{"reason": "ok", "verdict": "pass"}')],
  );
  await run();
  expect(received).toHaveLength(1);
  expect(resultsIn(out).meta.judge).toMatchObject({ via: "api" });
  const before = startsOf(box);
  const cases = path.join(box.root, "cases");
  const ran = await box.cli(["rejudge", out, "--cases", cases], {
    ANTHROPIC_API_KEY: KEY,
  });
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  expect(startsOf(box)).toBe(before);
  expect(received).toHaveLength(1);
  expect(onlyRecord(out, REJUDGED).judge).toMatchObject({
    calls: 0,
    cacheHits: 1,
  });
  // Results from before `meta.judge` say it in words.
  const stored = resultsIn(out);
  box.write(STORED, {
    ...stored,
    meta: { ...stored.meta, judge: undefined },
  });
  const old = await box.cli(["rejudge", out, "--cases", cases], {
    ANTHROPIC_API_KEY: KEY,
  });
  expect(old.stderr).not.toContain("judge differs");
  expect(onlyRecord(out, REJUDGED).judge).toMatchObject({ cacheHits: 1 });
  const changed = await box.cli(
    ["rejudge", out, "--cases", cases, "--judge-model", "other"],
    { ANTHROPIC_API_KEY: KEY },
  );
  expect(changed.stderr).toContain("the judge differs");
});

test("--out must not hold results, and must not be held by another command", async () => {
  const scored = await scoredWith([FIXED]);
  const taken = await scored.rejudge(["--out", scored.out + "-x"]);
  expect(taken.status, taken.stderr).toBe(EXIT.ok);
  const again = await scored.rejudge(["--out", scored.out + "-x"]);
  expect(again.status).toBe(EXIT.usage);
  expect(again.stderr).toContain("already holds results.json");
  const busy = path.join(scored.box.root, "busy");
  fs.mkdirSync(busy);
  fs.writeFileSync(
    path.join(busy, ".lock"),
    JSON.stringify({ pid: process.pid, hostname: "elsewhere" }),
  );
  const locked = await scored.rejudge(["--out", busy]);
  expect(locked.status).toBe(EXIT.usage);
  expect(locked.stderr).toContain(".lock");
  expect(fs.existsSync(path.join(busy, RESULTS))).toBe(false);
});

test("a directory that is not there is a usage error before anything is locked", async () => {
  const scored = await scoredWith([FIXED]);
  const ran = await scored.box.cli(["rejudge", "/nonexistent-results"]);
  expect(ran.status).toBe(EXIT.usage);
  expect(ran.stderr).toContain("results.jsonl");
});

test("decision answers are cached by slot and served to rejudge", async () => {
  const box = sandbox();
  const server = await decisionServer([
    { answers: { q1: yesNo(0.9), q2: choice({ a: 1 }) } },
  ]);
  const owned = plugin(box, "plugin-owned", { answer: ANSWER });
  box.write(CONFIG_FILE, { env: ["BASETEN_API_KEY"] });
  const cases = plantCase(box, [
    { type: "decision", question: "Is it plain?", expect: "yes" },
  ]);
  const out = path.join(box.root, "results");
  const env = { BASETEN_API_KEY: "skill-evals-decision-key" };
  await box.cli(
    [
      ...["score", "--subject", owned, "--cases", cases, "--reps", "1"],
      ...["--out", out, "--decision-model", "decider", "--decision-url"],
      server.url,
    ],
    env,
  );
  expect(server.received).toHaveLength(1);
  const first = onlyRecord(out).checks[0]?.score;
  const ran = await box.cli(["rejudge", out, "--cases", cases], env);
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  expect(server.received).toHaveLength(1);
  expect(onlyRecord(out, REJUDGED).checks[0]?.score).toBe(first);
});

test("a run scored with --lenient is rejudged with it", async () => {
  const box = sandbox();
  const mine = skillsFolder(box, "mine", { foo: "# foo\n" });
  const check = { type: "skill_loaded", skill: "foo" };
  script(box, "run", {
    turns: [
      [
        {
          call: { name: "Bash", input: { command: "cat skills/foo/SKILL.md" } },
        },
        { final: "done" },
      ],
    ],
  });
  const cases = plantCase(box, [check]);
  box.write("cases/restate/workspace/skills/foo/SKILL.md", "a fixture\n");
  const out = path.join(box.root, "results");
  await box.cli([
    ...["score", "--subject", mine, "--cases", cases, "--reps", "1"],
    ...["--out", out, "--lenient"],
  ]);
  expect(onlyRecord(out).checks[0]?.score).toBe(1);
  expect(resultsIn(out).meta.lenient).toBe(true);
  const ran = await box.cli(["rejudge", out, "--cases", cases]);
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  expect(onlyRecord(out, REJUDGED).checks[0]?.score).toBe(1);
  const strict = path.join(box.root, "strict");
  await box.cli(["rejudge", out, "--cases", cases, "--out", strict]);
  expect(onlyRecord(strict).checks[0]?.score).toBe(1);
});

test("a case with one changed run keeps all its runs", async () => {
  const scored = await scoredWith([FIXED], { flags: ["--reps", "2"] });
  const stored = resultsIn(scored.out);
  const [first, second] = stored.records;
  scored.box.write(STORED, {
    ...stored,
    records: [{ ...first, inputHash: "changed" }, second],
  });
  scored.rewrite([NEVER]);
  const ran = await scored.rejudge();
  expect(ran.stderr.match(/changed beyond its checks/g)).toHaveLength(2);
});

test("a path that leaves the output directory is not followed", async () => {
  const scored = await scoredWith([FIXED]);
  const stored = resultsIn(scored.out);
  const [record] = stored.records;
  scored.box.write(STORED, {
    ...stored,
    records: [{ ...record, transcriptFile: "../outside.json" }],
  });
  scored.rewrite([NEVER]);
  const ran = await scored.rejudge();
  expect(ran.stderr).toContain("is not inside");
  const archived = {
    ...record,
    workspaceArchive: { path: "/etc/x", bytes: 1 },
  };
  scored.box.write(STORED, { ...stored, records: [archived] });
  expect((await scored.rejudge()).stderr).toContain("is not inside");
});
