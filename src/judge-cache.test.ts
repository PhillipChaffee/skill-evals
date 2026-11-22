import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { cacheKey, openCache } from "./cache.js";
import { apiCase, evaluateCase, judgedWith, PASS } from "./testing/judged.js";
import { plantCase, plugin } from "./testing/plant.js";
import { reply } from "./testing/judge-server.js";
import { sandbox } from "./testing/sandbox.js";
import { EXIT } from "./exit-codes.js";

const RUBRIC = "It names the fix.";
const SCORE_HALF = '{"reason": "ok", "score": 0.5}';
const CACHE_FILE = "judge-cache.jsonl";

const linesOf = (out: string): { key: string }[] =>
  fs.existsSync(path.join(out, CACHE_FILE))
    ? fs
        .readFileSync(path.join(out, CACHE_FILE), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { key: string })
    : [];

test("a cached verdict is reused on a second identical question", async () => {
  const { run, evaluated, received, out } = await apiCase({ rubric: RUBRIC }, [
    reply(SCORE_HALF),
  ]);
  const first = await run();
  expect(first.check?.score).toBe(0.5);
  expect(received).toHaveLength(1);
  const lines = linesOf(out);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    score: 0.5,
    reason: "ok",
    usage: { tokens: { input: 100, output: 10 } },
  });

  const again = await evaluated({ useCache: true });
  expect(received).toHaveLength(1);
  expect(again.check?.score).toBe(0.5);
  expect(again.check?.reason).toBe("ok");
  expect(again.record?.judge).toMatchObject({ calls: 0, cacheHits: 1 });
  expect(linesOf(out)).toHaveLength(1);
});

test("a normal run writes the cache and never reads it", async () => {
  const { run, received, out } = await apiCase({ rubric: RUBRIC }, [
    reply(SCORE_HALF),
  ]);
  await run();
  const again = await run(["--reps", "2"]);
  // Two reps with the same answer are two questions, so judge noise shows.
  expect(received).toHaveLength(3);
  expect(again.record?.judge).not.toHaveProperty("cacheHits");
  expect(linesOf(out)).toHaveLength(3);
});

test("with the cache on, two reps are two slots and each asks", async () => {
  const { evaluated, received } = await apiCase({ rubric: RUBRIC }, [
    reply(SCORE_HALF),
    reply(SCORE_HALF),
  ]);
  await evaluated({ reps: 2, useCache: true });
  expect(received).toHaveLength(2);
});

test("votes are independent: each vote is cached on its own", async () => {
  const { run, evaluated, received, out } = await apiCase(
    { rubric: RUBRIC, votes: 3 },
    [
      reply(SCORE_HALF),
      reply('{"reason": "b", "score": 0.7}'),
      reply('{"reason": "c", "score": 0.9}'),
    ],
  );
  const first = await run();
  expect(received).toHaveLength(3);
  expect(first.check?.score).toBe(0.7);
  expect(linesOf(out)).toHaveLength(3);
  const again = await evaluated({ useCache: true });
  expect(received).toHaveLength(3);
  expect(again.check?.score).toBe(0.7);
  expect(again.check?.ballots?.map(({ score }) => score)).toEqual([
    0.5, 0.7, 0.9,
  ]);
  expect(again.record?.judge).toMatchObject({ calls: 0, cacheHits: 3 });
});

test("an unusable answer is not cached, so the next run asks again", async () => {
  const { run, evaluated, received, out } = await apiCase({ rubric: RUBRIC }, [
    reply("no json here"),
    reply("still none"),
    reply(SCORE_HALF),
  ]);
  const first = await run();
  expect(first.check?.score).toBeNull();
  expect(linesOf(out)).toHaveLength(0);
  const second = await evaluated({ useCache: true });
  expect(received).toHaveLength(3);
  expect(second.check?.score).toBe(0.5);
});

test("a cached entry with no score is ignored, and so is a damaged line", () => {
  const box = sandbox();
  const file = box.write(
    CACHE_FILE,
    `${JSON.stringify({ key: "a", score: null, reason: "x", usage: {} })}\nnot json\n${JSON.stringify({ key: "b", score: 1, reason: "y", usage: {} })}\n`,
  );
  const cache = openCache(path.dirname(file), true);
  expect(openCache(path.dirname(file)).get("b")).toBeUndefined();
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("b")).toMatchObject({ score: 1, reason: "y" });
});

test("the harness path writes the cache when it is off", async () => {
  const { prompts, ran, out } = await judgedWith(
    { rubric: RUBRIC, scale: "binary" },
    [PASS],
    { flags: ["--reps", "2"] },
  );
  expect(ran.status, ran.stderr).toBe(EXIT.invalid);
  // Off: both reps asked (the fake had one reply, so the second was unusable) and the one usable answer was written.
  expect(prompts).toHaveLength(3);
  expect(linesOf(out)).toHaveLength(1);
});

test("the harness path reads the cache when it is on", async () => {
  const box = sandbox();
  const owned = plugin(box, "plugin-owned", { answer: "It is fixed now." });
  const cases = plantCase(box, [
    { type: "judge", rubric: RUBRIC, scale: "binary" },
  ]);
  box.write("fake/judge/replies.json", [PASS]);
  const out = path.join(box.root, "results");
  const options = { subjects: [owned], cases, reps: 1, outDir: out };
  await evaluateCase(box, options);
  const again = await evaluateCase(box, { ...options, useCache: true });
  const prompts = fs
    .readFileSync(path.join(box.root, "fake/judge/prompts.jsonl"), "utf8")
    .trim()
    .split("\n");
  expect(prompts).toHaveLength(1);
  expect(again.check?.score).toBe(1);
  expect(again.record?.judge).toMatchObject({ calls: 0, cacheHits: 1 });
});

test("a cache that cannot be written keeps the verdict and warns once", async () => {
  const { run, out } = await apiCase({ rubric: RUBRIC, votes: 3 }, [
    reply(SCORE_HALF),
  ]);
  // A directory where the file belongs makes every append fail.
  fs.mkdirSync(path.join(out, CACHE_FILE), { recursive: true });
  const { ran, check } = await run();
  expect(ran.status, ran.stderr).toBe(0);
  expect(check?.score).toBe(0.5);
  const warnings = ran.stderr.match(/the judge cache could not be written: /g);
  expect(warnings).toHaveLength(1);
});

test("the key changes with the prompt, an attachment, the model, the scale and the vote", () => {
  const same = {
    prompt: "p",
    attachments: [{ sha256: "a" }],
    model: "m",
    scale: "binary" as const,
    vote: 0,
    via: "api",
  };
  const base = cacheKey(same);
  expect(base).toMatch(/^[0-9a-f]{64}$/);
  expect(cacheKey({ ...same })).toBe(base);
  const others = [
    { prompt: "q" },
    { attachments: [{ sha256: "b" }] },
    { attachments: [] },
    { model: "n" },
    { scale: "0-1" as const },
    { vote: 1 },
    { via: "codex" },
  ].map((change) => cacheKey({ ...same, ...change }));
  expect(new Set([base, ...others]).size).toBe(8);
});
