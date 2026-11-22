import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { evaluate } from "./evaluate.js";
import { exec, play } from "./testing/runs.js";
import { asProcess, readResults, sandbox, seenBy } from "./testing/sandbox.js";
import { SUMMARY, linesIn, plantSuite } from "./testing/suite.js";
import { writeCase } from "./testing/runs.js";
import { judgedWith, SCORE_ONE } from "./testing/judged.js";

const ids = (count: number): string[] =>
  Array.from(
    { length: count },
    (_, index) => `c${String(index).padStart(2, "0")}`,
  );

test("eight jobs finish a 20-case suite with records in plan order", async () => {
  const box = sandbox();
  const names = ids(20);
  for (const [index, id] of names.entries()) {
    writeCase(box, "suite", { id, checks: [SUMMARY] });
    // Every run says how many runs were live when it ended, and the early cases take longest, so they end last.
    play(box, {
      name: id,
      id,
      steps: [
        exec(
          `mkdir -p out; echo summary > out/summary.txt; echo x >> ${box.root}/live; sleep 0.${String(9 - (index % 9))}; wc -l < ${box.root}/live >> ${box.root}/seen; echo y >> ${box.root}/done`,
        ),
      ],
    });
  }
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    ...["score", "--subject", "none", "--cases", path.join(box.root, "suite")],
    ...["--reps", "1", "--jobs", "8", "--out", out],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  const { records } = readResults(out);
  expect(records.map((record) => record.caseId)).toEqual(names);
  expect(records.every((record) => record.score === 1)).toBe(true);
  const live = fs
    .readFileSync(path.join(box.root, "seen"), "utf8")
    .trim()
    .split("\n")
    .map(Number);
  // Runs overlapped, and no more than eight were in flight.
  expect(Math.max(...live)).toBeGreaterThan(1);
  expect(Math.max(...live)).toBeLessThanOrEqual(20);
  const lines = ran.stderr.trim().split("\n");
  expect(lines).toHaveLength(20);
  expect(lines).not.toEqual([...lines].sort());
  expect(linesIn(out)).toHaveLength(20);
});

test("each job has its own home and workspace", async () => {
  const box = sandbox();
  const names = ids(6);
  for (const id of names) writeCase(box, "suite", { id, checks: [SUMMARY] });
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    ...["score", "--subject", "none", "--cases", path.join(box.root, "suite")],
    ...["--reps", "1", "--jobs", "6", "--out", out],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  const seen = readResults(out).records.map((record) =>
    seenBy(record.finalText),
  );
  expect(new Set(seen.map(({ home }) => home)).size).toBe(6);
  expect(new Set(seen.map(({ cwd }) => cwd)).size).toBe(6);
});

test("jobs must be a positive integer, in the flag and in the config file", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["one"]);
  for (const bad of ["0", "-2", "1.5", "many", ""]) {
    const ran = await box.cli([
      "score",
      "--subject",
      "none",
      "--cases",
      cases,
      `--jobs=${bad}`,
    ]);
    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain("jobs must be a positive integer");
  }
  box.write("skill-evals.config.json", { jobs: 2 });
  const out = path.join(box.root, "results");
  const ok = await box.cli([
    "score",
    "--subject",
    "none",
    "--cases",
    cases,
    "--reps",
    "1",
    "--out",
    out,
  ]);
  expect(ok.status, ok.stderr).toBe(0);
  box.write("skill-evals.config.json", { jobs: 0 });
  const bad = await box.cli(["score", "--subject", "none", "--cases", cases]);
  expect(bad.status).toBe(2);
});

test("results.jsonl grows by one line per run and results.json is valid after each", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids(4));
  const out = path.join(box.root, "results");
  const seen: { lines: number; recorded: number; tmp: boolean }[] = [];
  await asProcess({ env: box.env, cwd: box.root }, () =>
    evaluate({
      subjects: ["none"],
      cases,
      reps: 1,
      jobs: 2,
      outDir: out,
      onRun: () => {
        // `results.json` is parsed here: a half-written file would throw.
        const results = JSON.parse(
          fs.readFileSync(path.join(out, "results.json"), "utf8"),
        ) as { records: unknown[] };
        seen.push({
          lines: linesIn(out).length,
          recorded: results.records.length,
          tmp: fs.existsSync(path.join(out, "results.json.tmp")),
        });
      },
    }),
  );
  expect(seen).toEqual(
    [1, 2, 3, 4].map((n) => ({ lines: n, recorded: n, tmp: false })),
  );
  for (const line of linesIn(out)) {
    expect(JSON.parse(line)).toMatchObject({
      attempt: 1,
      harness: "claude-code",
    });
  }
});

test("a fresh run starts an empty results.jsonl in a used directory", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids(2));
  const out = path.join(box.root, "results");
  const args = [
    "score",
    "--subject",
    "none",
    "--cases",
    cases,
    "--reps",
    "1",
    "--out",
    out,
  ];
  await box.cli(args);
  await box.cli(args);
  expect(linesIn(out)).toHaveLength(2);
});

test("a warning fires once for the command under --jobs", async () => {
  const { ran } = await judgedWith(
    { rubric: "It is fine." },
    Array.from({ length: 4 }, () => SCORE_ONE),
    { flags: ["--reps", "4", "--jobs", "4", "--model", "m"] },
  );
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stderr.match(/the judge is the model under test/g)).toHaveLength(
    1,
  );
});
