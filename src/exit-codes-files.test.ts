import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { evaluate } from "./evaluate.js";
import { EXIT } from "./exit-codes.js";
import { onFatal } from "./fatal.js";
import type { Summary } from "./summary.js";
import { resumeArgs, scoreArgs, scriptedCase } from "./testing/budget.js";
import { fixture, readResults, sandbox } from "./testing/sandbox.js";

const RESULTS = "results";
const ALPHA = "alpha";
const SUMMARY_FILE = "summary.json";
const TEST_TIMEOUT_MS = 60_000;
const summaryOf = (out: string): Summary =>
  JSON.parse(fs.readFileSync(path.join(out, SUMMARY_FILE), "utf8")) as Summary;

test("a command removes the reports of an earlier one, and names each file it writes", async () => {
  const box = sandbox();
  scriptedCase(box, ALPHA);
  const out = path.join(box.root, RESULTS);
  const first = await box.cli(scoreArgs(box, RESULTS, "--report", "json,html"));
  expect(first.stderr).toContain(
    `skill-evals: wrote ${path.join(out, "report.json")}`,
  );
  expect(first.stderr).toContain(
    `skill-evals: wrote ${path.join(out, "report.html")}`,
  );
  expect(first.stderr).toContain(
    `skill-evals: wrote ${path.join(out, SUMMARY_FILE)}`,
  );
  fs.writeFileSync(path.join(out, SUMMARY_FILE), "stale");
  const second = await box.cli(resumeArgs(box, RESULTS));
  expect(second.status, second.stderr).toBe(EXIT.ok);
  expect(fs.existsSync(path.join(out, "report.json"))).toBe(false);
  expect(fs.existsSync(path.join(out, "report.html"))).toBe(false);
  expect(summaryOf(out).exit).toBe(0);
});

test("a report that cannot be written is an error, and results.json and summary.json say 5", async () => {
  const box = sandbox();
  scriptedCase(box, ALPHA);
  const out = path.join(box.root, RESULTS);
  await expect(
    evaluate({
      cwd: box.root,
      subjects: ["none"],
      cases: "suite",
      reps: 1,
      outDir: out,
      onFinal: () => {
        throw new Error("disk full");
      },
    }),
  ).rejects.toThrow("disk full");
  expect(readResults(out).partial).toEqual({ reason: "error" });
  expect(summaryOf(out)).toMatchObject({ exit: EXIT.error, partial: "error" });
});

test("the summary is written after the reports", async () => {
  const box = sandbox();
  scriptedCase(box, ALPHA);
  const out = path.join(box.root, RESULTS);
  let seen: boolean | null = null;
  await evaluate({
    cwd: box.root,
    subjects: ["none"],
    cases: "suite",
    reps: 1,
    outDir: out,
    onFinal: () => {
      seen = fs.existsSync(path.join(out, SUMMARY_FILE));
    },
  });
  expect(seen).toBe(false);
  expect(fs.existsSync(path.join(out, SUMMARY_FILE))).toBe(true);
});

test("two harnesses that run are each asked for their version once", async () => {
  const box = sandbox();
  scriptedCase(box, ALPHA);
  const ran = await box.cli(
    scoreArgs(box, RESULTS, "--harness", "claude-code,pi"),
    { SKILL_EVALS_BIN_PI: box.pi },
  );
  expect(ran.status, ran.stderr).toBe(0);
  expect(fs.readFileSync(box.versions, "utf8").trim().split("\n")).toHaveLength(
    2,
  );
});

test("an uncaught exception and an unhandled rejection exit 5", () => {
  const ends: number[] = [];
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  onFatal(new Error("late"), (code) => ends.push(code));
  onFatal("plain text", (code) => ends.push(code));
  expect(ends).toEqual([5, 5]);
  expect(quiet.mock.calls.flat().join("\n")).toMatch(
    /internal error: Error: late\n\s+at /,
  );
  quiet.mockRestore();
});

test.skipIf(!process.features.typescript)(
  "the installed handlers end a process whose timer throws, and one with a rejected promise, with 5",
  () => {
    const run = (body: string) =>
      spawnSync(
        process.execPath,
        [
          ...["--import", fixture("ts-register.mjs")],
          ...[
            "-e",
            `const { installFatalHandlers } = await import(${JSON.stringify(path.resolve(import.meta.dirname, "fatal.ts"))}); installFatalHandlers(); ${body}`,
          ],
          "--input-type=module",
        ],
        { encoding: "utf8" },
      );
    const thrown = run('setTimeout(() => { throw new Error("late"); }, 10);');
    expect(thrown.status, thrown.stderr).toBe(EXIT.error);
    expect(thrown.stderr).toContain("internal error: Error: late");
    const rejected = run('Promise.reject(new Error("nobody waits"));');
    expect(rejected.status, rejected.stderr).toBe(EXIT.error);
  },
  TEST_TIMEOUT_MS,
);
