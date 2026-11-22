import path from "node:path";
import { expect, test } from "vitest";
import { evaluate } from "./evaluate.js";
import { scoreArgs, scriptedCase } from "./testing/budget.js";
import { asProcess, readResults, sandbox } from "./testing/sandbox.js";
import { linesIn, startsOf } from "./testing/suite.js";
import fs from "node:fs";

/**
 * Reads the stored lines of a command's `results.jsonl`.
 * @param out - The output directory.
 * @returns The parsed lines.
 */
const CRASHED = { error: "no result event" };
const stored = (out: string) =>
  linesIn(out).map(
    (line) => JSON.parse(line) as { attempt: number; attempts?: unknown },
  );

test("a crash is retried once and both attempts are recorded", async () => {
  const box = sandbox();
  // The harness dies on its first start, and counts its starts in a file, so the second start plays on.
  scriptedCase(box, "solo", {
    before: [{ onStart: [1], step: { crash: "segfault" } }],
  });
  const out = path.join(box.root, "results");
  const ran = await box.cli(scoreArgs(box, "results", "--retries", "1"));
  expect(ran.status, ran.stderr).toBe(0);
  expect(startsOf(box)).toBe(2);
  const [record] = readResults(out).records;
  expect(record?.score).toBe(1);
  expect(record?.error).toBeNull();
  expect(record?.attempts).toEqual([CRASHED]);
  // The jsonl keeps the final attempt's line only, and says which attempt it was.
  const lines = stored(out);
  expect(lines).toHaveLength(1);
  expect(lines[0]?.attempt).toBe(2);
  expect(lines[0]?.attempts).toEqual([CRASHED]);
});

test("a crash is not retried without --retries, and the run is invalid", async () => {
  const box = sandbox();
  scriptedCase(box, "solo", {
    before: [{ onStart: [1], step: { crash: "segfault" } }],
  });
  const out = path.join(box.root, "results");
  const ran = await box.cli(scoreArgs(box, "results"));
  expect(ran.status).toBe(1);
  expect(startsOf(box)).toBe(1);
  const [record] = readResults(out).records;
  expect(record).not.toHaveProperty("attempts");
  expect(stored(out)[0]?.attempt).toBe(1);
});

test("the retries run out: three crashes with --retries 2 leave an invalid run with two earlier errors", async () => {
  const box = sandbox();
  scriptedCase(box, "solo", {
    before: [{ onStart: [1, 2, 3], step: { crash: "segfault" } }],
  });
  const out = path.join(box.root, "results");
  const ran = await box.cli(scoreArgs(box, "results", "--retries", "2"));
  expect(ran.status).toBe(1);
  expect(startsOf(box)).toBe(3);
  const [record] = readResults(out).records;
  expect(record?.attempts).toHaveLength(2);
  expect(record?.error).toBe("no result event");
  expect(stored(out)[0]?.attempt).toBe(3);
});

test("a low score is never retried", async () => {
  const box = sandbox();
  // A case whose check fails: the agent does not write the file.
  box.write("suite/low/prompt.md", "do low\n");
  box.write("suite/low/case.json", {
    checks: [{ type: "file_matches", path: "out/none.txt", pattern: "x" }],
  });
  const out = path.join(box.root, "results");
  const ran = await box.cli(scoreArgs(box, "results", "--retries", "3"));
  expect(ran.status, ran.stderr).toBe(0);
  expect(startsOf(box)).toBe(1);
  const [record] = readResults(out).records;
  expect(record?.score).toBe(0);
  expect(record).not.toHaveProperty("attempts");
});

test("a timeout before the harness wrote anything is retried", async () => {
  const box = sandbox();
  scriptedCase(box, "quiet", {
    noInit: true,
    more: { timeoutSeconds: 1 },
    before: [{ onStart: [1], step: { hang: true } }],
  });
  const out = path.join(box.root, "results");
  const ran = await box.cli(scoreArgs(box, "results", "--retries", "1"));
  expect(ran.status, ran.stderr).toBe(0);
  expect(startsOf(box)).toBe(2);
  const [record] = readResults(out).records;
  expect(record?.attempts).toEqual([{ error: "timed out after 1 s" }]);
  expect(record?.score).toBe(1);
});

test("a timeout after the harness wrote something is not retried", async () => {
  const box = sandbox();
  // The init event is output, so `firstOutputMs` is set.
  scriptedCase(box, "late", {
    more: { timeoutSeconds: 1 },
    before: [{ onStart: [1], step: { hang: true } }],
  });
  const out = path.join(box.root, "results");
  const ran = await box.cli(scoreArgs(box, "results", "--retries", "2"));
  expect(ran.status).toBe(1);
  expect(startsOf(box)).toBe(1);
  expect(readResults(out).records[0]).not.toHaveProperty("attempts");
});

test("a setup failure is not retried", async () => {
  const box = sandbox();
  scriptedCase(box, "broken", { more: { setup: [{ run: "exit 3" }] } });
  const out = path.join(box.root, "results");
  const ran = await box.cli(scoreArgs(box, "results", "--retries", "2"));
  expect(ran.status).toBe(1);
  // The harness never started, so there was nothing to try again.
  expect(startsOf(box)).toBe(0);
  const [record] = readResults(out).records;
  expect(record?.error).toMatch(/setup/);
  expect(record).not.toHaveProperty("attempts");
});

test("a rate limit is retried, with the wait overridden to nothing", async () => {
  const box = sandbox();
  scriptedCase(box, "limited", {
    before: [
      { onStart: [1, 2], step: { fail: "429 Too Many Requests: rate limit" } },
    ],
  });
  const out = path.join(box.root, "results");
  const started = Date.now();
  const { value } = await asProcess({ env: box.env, cwd: box.root }, () =>
    evaluate({
      subjects: ["none"],
      cases: path.join(box.root, "suite"),
      reps: 1,
      outDir: out,
      retries: 2,
      rateLimitBackoffMs: 0,
    }),
  );
  expect(Date.now() - started, "no 30 s wait").toBeLessThan(25_000);
  expect(startsOf(box)).toBe(3);
  const [record] = value.records;
  expect(record?.score).toBe(1);
  expect(record?.attempts).toHaveLength(2);
  expect(record?.attempts?.[0]?.error).toMatch(/rate limit/);
  expect(fs.existsSync(path.join(out, "results.json"))).toBe(true);
});

test("a run that reports a rate limit is not retried without retries", async () => {
  const box = sandbox();
  scriptedCase(box, "limited", {
    before: [{ step: { fail: "rate limit" }, onStart: [1] }],
  });
  const ran = await box.cli(scoreArgs(box, "results"));
  expect(ran.status).toBe(1);
  expect(startsOf(box)).toBe(1);
});
