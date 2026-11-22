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

test(
  "eight jobs finish a 20-case suite with records in plan order",
  { timeout: 60_000 },
  async () => {
    const box = sandbox();
    const names = ids(20);
    const [started, done, seen] = ["started", "done", "seen"].map((name) =>
      path.join(box.root, name),
    ) as [string, string, string];
    fs.writeFileSync(done, "");
    for (const [index, id] of names.entries()) {
      writeCase(box, "suite", { id, checks: [SUMMARY] });
      // Each run notes how many runs are in flight when it starts: those started and not yet done. The early cases
      // take longest, so they end last.
      play(box, {
        name: id,
        id,
        steps: [
          exec(
            `mkdir -p out; echo summary > out/summary.txt; echo s >> ${started}; echo $(( $(wc -l < ${started}) - $(wc -l < ${done}) )) >> ${seen}; sleep 0.${String(9 - (index % 9))}; echo d >> ${done}`,
          ),
        ],
      });
    }
    const out = path.join(box.root, "results");
    const ran = await box.cli([
      ...[
        "score",
        "--subject",
        "none",
        "--cases",
        path.join(box.root, "suite"),
      ],
      ...["--reps", "1", "--jobs", "8", "--out", out],
    ]);
    expect(ran.status, ran.stderr).toBe(0);
    const { records } = readResults(out);
    expect(records.map((record) => record.caseId)).toEqual(names);
    expect(records.every((record) => record.score === 1)).toBe(true);
    const flying = fs.readFileSync(seen, "utf8").trim().split("\n").map(Number);
    expect(flying).toHaveLength(20);
    // Runs overlapped, and never more than eight were in flight.
    expect(Math.max(...flying)).toBeGreaterThan(1);
    expect(Math.max(...flying)).toBeLessThanOrEqual(8);
    const lines = ran.stderr.trim().split("\n");
    expect(lines).toHaveLength(20);
    expect(lines).not.toEqual([...lines].sort());
    expect(linesIn(out)).toHaveLength(20);
  },
);

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

test("results.jsonl grows by one line per run and results.json is valid whenever it exists", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids(4));
  const out = path.join(box.root, "results");
  const seen: { lines: number; partial: unknown; tmp: boolean }[] = [];
  await asProcess({ env: box.env, cwd: box.root }, () =>
    evaluate({
      subjects: ["none"],
      cases,
      reps: 1,
      jobs: 2,
      outDir: out,
      onRun: () => {
        // `results.json` is parsed here: a half-written file would throw. It is written once at the start and then at
        // most every ten seconds, so it need not hold this run yet.
        const results = JSON.parse(
          fs.readFileSync(path.join(out, "results.json"), "utf8"),
        ) as { partial: unknown };
        seen.push({
          lines: linesIn(out).length,
          partial: results.partial,
          tmp: fs.existsSync(path.join(out, "results.json.tmp")),
        });
      },
    }),
  );
  expect(seen.map(({ lines }) => lines)).toEqual([1, 2, 3, 4]);
  expect(seen.every(({ tmp }) => !tmp)).toBe(true);
  // Every snapshot taken while the command ran says so.
  expect(seen.map(({ partial }) => partial)).toEqual(
    Array.from({ length: 4 }, () => ({ reason: "running" })),
  );
  const last = readResults(out);
  expect(last.partial).toBeNull();
  expect(last.records.map((record) => record.caseId)).toEqual(ids(4));
  for (const line of linesIn(out)) {
    expect(JSON.parse(line)).toMatchObject({
      attempt: 1,
      harness: "claude-code",
    });
  }
});

test("a fresh run into a directory that holds runs is a usage error, and removing results.jsonl allows it", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids(2));
  const out = path.join(box.root, "results");
  const args = ["score", "--subject", "none", "--cases", cases, "--reps", "1"];
  expect((await box.cli([...args, "--out", out])).status).toBe(0);
  const again = await box.cli([...args, "--out", out], { KEEP_RUNS: "1" });
  expect(again.status).toBe(2);
  expect(again.stderr).toContain(
    `${out} holds 2 runs of an earlier command; pass --resume ${out}, remove results.jsonl, or choose another --out`,
  );
  expect(linesIn(out)).toHaveLength(2);
  // A directory with results.json from before and no results.jsonl is overwritten as it always was.
  fs.rmSync(path.join(out, "results.jsonl"));
  expect(
    (await box.cli([...args, "--out", out], { KEEP_RUNS: "1" })).status,
  ).toBe(0);
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
