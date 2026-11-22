import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { evaluate } from "./evaluate.js";
import type { Exiting } from "./exit-codes.js";
import { EXIT, exitCodeOf, strongest } from "./exit-codes.js";
import type { RunRecord } from "./run.js";
import { priced, scoreArgs, scriptedCase } from "./testing/budget.js";
import { plugin } from "./testing/plant.js";
import { exec, play, scoreSubject, writeCase } from "./testing/runs.js";
import { fixture, readResults, sandbox } from "./testing/sandbox.js";
import { linesIn } from "./testing/suite.js";
import type { Summary } from "./summary.js";

const RESULTS = "results";
const ALPHA = "alpha";
const MAX_INVALID = "--max-invalid";
const SUMMARY_FILE = "summary.json";
const MIN_SCORE = "--min-score";
const TEST_TIMEOUT_MS = 60_000;
const POLL_MS = 25;
const WAIT_MS = 30_000;
const CRASH_ONCE = [{ onStart: [1], step: { crash: "segfault" } }];
const NEVER = { type: "output_contains", text: "never said" };

/**
 * Reads the `summary.json` of an output directory.
 * @param out - The output directory.
 * @returns The parsed summary.
 */
const summaryOf = (out: string): Summary =>
  JSON.parse(fs.readFileSync(path.join(out, SUMMARY_FILE), "utf8")) as Summary;

test("exit 0: every run is valid and no pass bar is missed", async () => {
  const box = sandbox();
  scriptedCase(box, ALPHA);
  const ran = await box.cli(scoreArgs(box, RESULTS, MIN_SCORE, "1"));
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  expect(summaryOf(path.join(box.root, RESULTS))).toMatchObject({
    exit: 0,
    invalid: 0,
    belowBar: [],
    partial: null,
  });
});

test("exit 1: a pass bar is not reached", async () => {
  const box = sandbox();
  scriptedCase(box, ALPHA, { checks: [NEVER] });
  const ran = await box.cli(scoreArgs(box, RESULTS, MIN_SCORE, "0.9"));
  expect(ran.status, ran.stderr).toBe(EXIT.bar);
  const summary = summaryOf(path.join(box.root, RESULTS));
  expect(summary.exit).toBe(1);
  expect(summary.belowBar).toHaveLength(1);
});

test("exit 2: a wrong command line is a usage error, and writes no summary", async () => {
  const box = sandbox();
  scriptedCase(box, ALPHA);
  for (const bad of [
    [MAX_INVALID, "2"],
    [MAX_INVALID, "x"],
    ["--report", "pdf"],
  ]) {
    const ran = await box.cli(scoreArgs(box, RESULTS, ...bad));
    expect(ran.status, bad.join(" ")).toBe(EXIT.usage);
    expect(ran.stderr).toMatch(/^skill-evals: /);
  }
  expect(fs.existsSync(path.join(box.root, RESULTS, SUMMARY_FILE))).toBe(false);
});

test("exit 3: an invalid run", async () => {
  const box = sandbox();
  scriptedCase(box, ALPHA, { before: CRASH_ONCE });
  const ran = await box.cli(scoreArgs(box, RESULTS));
  expect(ran.status, ran.stderr).toBe(EXIT.invalid);
  expect(summaryOf(path.join(box.root, RESULTS))).toMatchObject({
    exit: 3,
    invalid: 1,
  });
});

test("exit 3: a subject directory that changed while the command ran, with its message", async () => {
  const box = sandbox();
  const kit = plugin(box, "kit", {});
  const skill = box.write("kit/skills/x/SKILL.md", "original\n");
  writeCase(box, "cases", {
    id: "meddle",
    checks: [{ type: "subject_unchanged" }],
  });
  play(box, {
    name: "meddle",
    id: "meddle",
    steps: [exec(`echo more >> "${skill}"`)],
  });
  const { status, stderr } = await scoreSubject(box, {
    subject: kit,
    cases: path.join(box.root, "cases"),
  });
  expect(status).toBe(EXIT.invalid);
  expect(stderr).toContain(
    `skill-evals: the subject directory changed during the run: ${path.join(kit, "skills/x/SKILL.md")}`,
  );
});

test("exit 4: a budget stopped the command, and wins over a missed bar", async () => {
  const box = sandbox();
  priced(box, ["bravo", "charlie"], 0.4);
  scriptedCase(box, ALPHA, { costUsd: 0.4, checks: [NEVER] });
  const ran = await box.cli(
    scoreArgs(box, RESULTS, "--max-cost", "0.5", MIN_SCORE, "0.9"),
  );
  expect(ran.status, ran.stderr).toBe(EXIT.partial);
  expect(summaryOf(path.join(box.root, RESULTS))).toMatchObject({
    exit: 4,
    partial: "budget",
  });
});

test("exit 5: an internal failure prints a stack trace, and is not a usage error", async () => {
  const box = sandbox();
  scriptedCase(box, ALPHA);
  // A directory where results.json belongs makes the first write fail with an error that is not a usage error.
  fs.mkdirSync(path.join(box.root, RESULTS, "results.json", "x"), {
    recursive: true,
  });
  const ran = await box.cli(scoreArgs(box, RESULTS));
  expect(ran.status).toBe(EXIT.error);
  expect(ran.stderr).toMatch(/^skill-evals: internal error: .*\n\s+at /s);
});

test("a run that throws leaves results.json and summary.json saying error, and exits 5", async () => {
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
      onRun: () => {
        throw new Error("boom");
      },
    }),
  ).rejects.toThrow("boom");
  expect(readResults(out).partial).toEqual({ reason: "error" });
  expect(summaryOf(out)).toMatchObject({ exit: EXIT.error, partial: "error" });
});

/**
 * Waits for a condition.
 * @param ready - Tells whether it holds.
 * @param what - What is waited for, for the failure.
 */
async function until(ready: () => boolean, what: string): Promise<void> {
  const end = Date.now() + WAIT_MS;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// Type stripping, which the child needs to run the sources, is on by default from Node 22.18.
test.skipIf(!process.features.typescript)(
  "exit 130: a signal ends the command, and summary.json says interrupted",
  async () => {
    const box = sandbox();
    scriptedCase(box, ALPHA);
    scriptedCase(box, "bravo", {
      before: [{ onStart: [1], step: { hang: true } }],
    });
    const out = path.join(box.root, RESULTS);
    const child = spawn(
      process.execPath,
      [
        ...["--import", fixture("ts-register.mjs")],
        path.resolve(import.meta.dirname, "bin.ts"),
        ...scoreArgs(box, RESULTS, "--jobs", "1"),
      ],
      { cwd: box.root, env: box.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    onTestFinished(() => {
      child.kill("SIGKILL");
    });
    await until(
      () =>
        fs.existsSync(path.join(out, "results.jsonl")) &&
        linesIn(out).length === 1 &&
        fs.existsSync(path.join(box.root, "fake/starts/case-bravo.json")),
      "the first run to finish and the second to hang",
    );
    // Writes while the command runs are interim: they never make a summary.
    expect(fs.existsSync(path.join(out, SUMMARY_FILE))).toBe(false);
    child.kill("SIGINT");
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(EXIT.interrupted);
    expect(summaryOf(out)).toMatchObject({
      exit: 130,
      partial: "interrupted",
    });
  },
  TEST_TIMEOUT_MS,
);

test("--max-invalid 0.5 tolerates one of three", async () => {
  const box = sandbox();
  for (const id of ["alpha", "bravo", "charlie"]) {
    scriptedCase(box, id, id === "bravo" ? { before: CRASH_ONCE } : {});
  }
  const out = path.join(box.root, RESULTS);
  const strict = await box.cli(scoreArgs(box, RESULTS));
  expect(strict.status, strict.stderr).toBe(EXIT.invalid);
  fs.rmSync(path.join(out, "results.jsonl"));
  const tolerant = await box.cli(scoreArgs(box, RESULTS, MAX_INVALID, "0.5"));
  expect(tolerant.status, tolerant.stderr).toBe(EXIT.ok);
});

/**
 * Makes the part of the results that decides the exit code.
 * @param more - Fields that differ.
 * @returns A command that ran to the end: one suite of one case with three planned runs, none invalid.
 */
const exiting = (more: Partial<Exiting> = {}): Exiting => ({
  partial: null,
  sourceChanged: [],
  belowBar: [],
  records: [],
  suites: [
    {
      harness: "h",
      cases: [],
      suite: {},
      applicable: 1,
      total: 1,
      runs: { subject: { valid: 3, planned: 3 } },
    },
  ],
  ...more,
});
const invalid = (skipped = false): RunRecord =>
  ({
    error: "crash",
    checks: [],
    ...(skipped ? { skippedGraders: true } : {}),
  }) as unknown as RunRecord;

test("when several exit codes apply, usage wins, then interrupted, error, partial, invalid and bar", () => {
  const every = [
    EXIT.bar,
    EXIT.invalid,
    EXIT.partial,
    EXIT.error,
    EXIT.interrupted,
    EXIT.usage,
  ];
  const order = [
    EXIT.usage,
    EXIT.interrupted,
    EXIT.error,
    EXIT.partial,
    EXIT.invalid,
    EXIT.bar,
  ];
  for (const [index, code] of order.entries()) {
    expect(
      strongest(every.filter((each) => order.indexOf(each) >= index)),
    ).toBe(code);
  }
  expect(strongest([])).toBe(EXIT.ok);

  const stopped = { partial: { reason: "budget" as const } };
  const bad = { records: [invalid()], belowBar: ["h: below"] };
  expect(exitCodeOf(exiting({ ...bad }))).toBe(EXIT.invalid);
  expect(exitCodeOf(exiting({ belowBar: ["h: below"] }))).toBe(EXIT.bar);
  expect(exitCodeOf(exiting({ ...bad, ...stopped }))).toBe(EXIT.partial);
  expect(exitCodeOf(exiting({ ...bad, partial: { reason: "error" } }))).toBe(
    EXIT.error,
  );
  expect(
    exitCodeOf(exiting({ ...bad, partial: { reason: "interrupted" } })),
  ).toBe(EXIT.interrupted);
  expect(
    exitCodeOf(exiting({ sourceChanged: ["kit/x"], belowBar: ["h: below"] })),
  ).toBe(EXIT.invalid);
});

test("a run that did not run is not invalid, and the share is over the planned runs", () => {
  const one = exiting({ records: [invalid()] });
  expect(exitCodeOf(one, 0)).toBe(EXIT.invalid);
  expect(exitCodeOf(one, 0.3)).toBe(EXIT.invalid);
  expect(exitCodeOf(one, 1 / 3)).toBe(EXIT.ok);
  expect(exitCodeOf(one, 0.5)).toBe(EXIT.ok);
  expect(exitCodeOf(exiting({ records: [invalid(true)] }))).toBe(EXIT.ok);
  expect(exitCodeOf(exiting({ suites: [] }))).toBe(EXIT.ok);
});
