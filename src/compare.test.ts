import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { plantCase, plugin } from "./testing/plant.js";
import { readResults, sandbox, seenBy, tableRow } from "./testing/sandbox.js";
import { EXIT } from "./exit-codes.js";

const ALPHA = "plugin-alpha";
const BETA = "plugin-beta";
const CHECKS = [
  { type: "skill_loaded", skill: "bro" },
  { type: "skill_not_loaded", skill: "bro" },
  { type: "output_matches", pattern: '"seed":"planted"' },
  { type: "output_lacks", pattern: '"leaks":0' },
  { type: "file_exists", path: "out/summary.txt" },
  { type: "file_exists", path: "out/missing.txt" },
  {
    type: "file_matches",
    path: "out/summary.txt",
    pattern: "^summary by plugin-beta$",
    flags: "m",
  },
];

/**
 * Compares a plain plugin with one whose agent loads the skill `bro`, twice each.
 * @returns What the command did, and where its results are.
 */
async function compared() {
  const box = sandbox();
  const pluginA = plugin(box, ALPHA, { costUsd: 0.01 });
  const pluginB = plugin(box, BETA, { costUsd: 0.03, skill: "bro" });
  const outDir = path.join(box.root, "results");
  const cases = plantCase(box, CHECKS);
  const flags = ["--cases", cases, "--reps", "2", "--out", outDir];
  const result = await box.cli([
    "run",
    "--a",
    pluginA,
    "--b",
    pluginB,
    ...flags,
  ]);
  return { result, outDir, records: readResults(outDir).records };
}

test("run scores every check for both plugin directories, in a throwaway home and workspace that it removes", async () => {
  const { result, records } = await compared();
  expect(result.status, result.stderr).toBe(0);

  expect(
    records.map((r) => `${r.harness} ${r.caseId} ${r.subject}${String(r.rep)}`),
  ).toEqual(
    ["a1", "b1", "a2", "b2"].map((run) => `claude-code restate ${run}`),
  );
  const scores = (label: string) =>
    records
      .find((record) => record.subject === label)
      ?.checks.map((check) => check.score);
  expect(scores("a")).toEqual([0, 1, 1, 0, 1, 0, 0]);
  expect(scores("b")).toEqual([1, 0, 1, 0, 1, 0, 1]);
  for (const record of records) {
    expect(record.ok).toBe(true);
    expect(record.subjectLoaded).toBe(true);
    expect(record.skillsLoaded).toEqual(record.subject === "b" ? ["bro"] : []);
    expect(record.tokens).toEqual({ input: 1000, output: 50 });
    const seen = seenBy(record.finalText);
    expect(seen.prompt).toBe("say it in plain words");
    expect(path.basename(seen.home)).toMatch(/^home-/);
    expect(path.basename(seen.cwd)).toMatch(/^proj-/);
    expect(fs.existsSync(seen.home), "the throwaway home").toBe(false);
    expect(fs.existsSync(seen.cwd), "the workspace").toBe(false);
  }
});

test("run reports the difference between the two subjects and keeps each run's stream and final text", async () => {
  const { result, outDir, records } = await compared();

  const row = tableRow(result.stdout, "restate");
  expect(row).toMatch(/`skill_loaded bro` A 0\/2, B 2\/2/);
  expect(row).toMatch(
    /`file_matches out\/summary\.txt \/\^summary by plugin-beta\$\/m` A 0\/2, B 2\/2/,
  );
  expect(row).toMatch(/\$0\.0100 \/ \$0\.0300 \(\+\$0\.0200\)/);
  expect(row).toMatch(/1000 \/ 1000 \(\+0\)/);
  expect(result.stdout).toMatch(/^- Harness: claude-code \(default/m);
  // Each line ends with the progress text, whose spend and time are not fixed.
  expect(
    result.stderr
      .trim()
      .split("\n")
      .map((line) => line.replace(/ \[\d+\/\d+\] .*$/, "")),
  ).toEqual(
    ["a1", "b1", "a2", "b2"].map(
      (run, index) =>
        `claude-code restate ${run}: score ${index % 2 ? "0.57" : "0.43"}`,
    ),
  );

  const runDir = path.join(outDir, "claude-code/restate");
  expect(fs.readFileSync(path.join(runDir, "b2.final.md"), "utf8")).toBe(
    records[3]?.finalText,
  );
  expect(fs.readFileSync(path.join(runDir, "a1.stream.jsonl"), "utf8")).toMatch(
    /"type":"result"/,
  );
});

test("run does not count a run whose harness loaded some other plugin, and exits non-zero", async () => {
  const box = sandbox();
  const pluginA = plugin(box, ALPHA, { costUsd: 0.01 });
  const ghost = { costUsd: 0.01, skill: "bro", ghost: true };
  const pluginB = plugin(box, "plugin-ghost", ghost);
  const outDir = path.join(box.root, "results");
  const flags = ["--cases", plantCase(box, CHECKS), "--reps", "1"];

  const result = await box.cli([
    "run",
    "--a",
    pluginA,
    "--b",
    pluginB,
    ...flags,
    "--out",
    outDir,
  ]);
  expect(result.status, result.stderr).toBe(EXIT.invalid);

  const { records } = readResults(outDir);
  expect(records.map((record) => record.subjectLoaded)).toEqual([true, false]);
  const row = tableRow(result.stdout, "restate");
  expect(row).toMatch(/`skill_loaded bro` A 0\/1, B n\/a/);
  expect(result.stdout).toMatch(/^- B `restate` rep 1: /m);
});

const WEIGHTED = [
  { type: "skill_loaded", skill: "bro", weight: 3 },
  { type: "output_contains", text: '"seed":"planted"' },
  { type: "tool_called", kind: "skill", inputMatches: "plugin:bro" },
  { type: "tool_not_called", name: "^Bash$" },
];
const MIN_SCORE = "--min-score";
const ONE_RUN = { valid: 1, planned: 1 };
const TWO_RUNS = { valid: 2, planned: 2 };

/**
 * Plants a plain plugin, a skilled one, the weighted case, and a second case of weight 2 that every run passes.
 * @returns The two plugin directories and a `run` that compares two of them once.
 */
function weighted() {
  const box = sandbox();
  const plain = plugin(box, ALPHA, { costUsd: 0.01 });
  const skilled = plugin(box, BETA, { costUsd: 0.01, skill: "bro" });
  const cases = plantCase(box, WEIGHTED);
  box.write("cases/steady/prompt.md", "anything\n");
  box.write("cases/steady/case.json", {
    checks: [{ type: "output_not_contains", text: "no such text" }],
    weight: 2,
  });
  const outDir = path.join(box.root, "results");
  const run = (a: string, b: string, ...extra: string[]) => {
    const flags = ["--cases", cases, "--reps", "1", "--out", outDir, ...extra];
    return box.cli(["run", "--a", a, "--b", b, ...flags]);
  };
  return { box, plain, skilled, outDir, run };
}

test("scores are weighted means of the checks and of the cases", async () => {
  const { plain, skilled, outDir, run } = weighted();
  const better = await run(plain, skilled, MIN_SCORE, "0.9");
  expect(better.status, better.stderr).toBe(0);
  // In restate, A passes 2 of the weights 3+1+1+1 and B passes all. In the suite, restate has weight 1 and steady 2.
  const results = readResults(outDir);
  expect(
    results.records.map(
      (r) => `${r.caseId} ${r.subject} ${String(r.score?.toFixed(3))}`,
    ),
  ).toEqual([
    "restate a 0.333",
    "restate b 1.000",
    "steady a 1.000",
    "steady b 1.000",
  ]);
  expect(results.suites).toEqual([
    {
      harness: "claude-code",
      cases: [
        {
          id: "restate",
          weight: 1,
          scores: { a: 1 / 3, b: 1 },
          runs: { a: ONE_RUN, b: ONE_RUN },
        },
        {
          id: "steady",
          weight: 2,
          scores: { a: 1, b: 1 },
          runs: { a: ONE_RUN, b: ONE_RUN },
        },
      ],
      suite: { a: (1 / 3 + 2) / 3, b: 1 },
      applicable: 2,
      total: 2,
      runs: { a: TWO_RUNS, b: TWO_RUNS },
    },
  ]);
  expect(better.stdout).toMatch(
    /^\| restate \| 0\.33 \/ 1\.00 \(\+0\.67\) \(A 1 of 1 runs, B 1 of 1 runs\) \| `skill_loaded bro \(weight 3\)` A 0\/1, B 1\/1<br>/m,
  );
  expect(better.stdout).toMatch(
    /^Suite score: 0\.78 \/ 1\.00 \(\+0\.22\) \(2 of 2 cases, A 2 of 2 runs, B 2 of 2 runs\)$/m,
  );
  expect(better.stdout).not.toMatch(/pass bar/);
});

test("a suite or case score of B under its bar fails the command", async () => {
  const { box, plain, skilled, outDir, run } = weighted();
  const worse = await run(skilled, plain, MIN_SCORE, "0.9");
  expect(worse.status).toBe(1);
  expect(worse.stdout).toMatch(
    /^- claude-code: suite score 0\.78 \(2 of 2 runs\) does not reach --min-score 0\.90$/m,
  );
  expect(readResults(outDir).belowBar).toHaveLength(1);
  expect((await run(skilled, plain, MIN_SCORE, "0.7")).status).toBe(0);

  plantCase(box, WEIGHTED, { minScore: 0.5 });
  const underCaseBar = await run(skilled, plain);
  expect(underCaseBar.status).toBe(1);
  expect(underCaseBar.stdout).toMatch(
    /^- claude-code: case `restate` score 0\.33 \(1 of 1 runs\) does not reach its minScore 0\.50$/m,
  );
  const reversed = await run(plain, skilled);
  expect(reversed.status, "the bars apply to B").toBe(0);
});

test("score runs the suite on one subject and applies the pass bar to it", async () => {
  const box = sandbox();
  const plain = plugin(box, ALPHA, { costUsd: 0.01 });
  const skilled = plugin(box, BETA, { costUsd: 0.03, skill: "bro" });
  const cases = plantCase(box, WEIGHTED);
  const outDir = path.join(box.root, "results");
  const score = (dir: string, ...extra: string[]) => {
    const flags = ["--cases", cases, "--reps", "2", "--out", outDir, ...extra];
    return box.cli(["score", "--subject", dir, ...flags]);
  };

  const good = await score(skilled, MIN_SCORE, "1");
  expect(good.status, good.stderr).toBe(0);
  const { records, subjects } = readResults(outDir);
  expect(
    records.map((r) => `${r.subject}${String(r.rep)} ${String(r.score)}`),
  ).toEqual(["subject1 1", "subject2 1"]);
  expect(subjects.map((subject) => [subject.kind, subject.dir])).toEqual([
    ["plugin", skilled],
  ]);
  expect(good.stdout).toMatch(/^# Skill scores$/m);
  expect(good.stdout).toMatch(
    /^\| restate \| 1\.00 \(2 of 2 runs\) \| `skill_loaded bro \(weight 3\)` 2\/2<br>.*\| \$0\.0300 \|$/m,
  );
  expect(good.stdout).toMatch(
    /^Suite score: 1\.00 \(1 of 1 cases, 2 of 2 runs\)$/m,
  );
  const kept = path.join(outDir, "claude-code/restate/subject2.final.md");
  expect(fs.existsSync(kept)).toBe(true);

  const bad = await score(plain, MIN_SCORE, "0.5");
  expect(bad.status).toBe(1);
  expect(bad.stdout).toMatch(
    /suite score 0\.33 \(2 of 2 runs\) does not reach --min-score 0\.50/,
  );
  const twoSubjects = await box.cli(["score", "--a", plain, "--cases", cases]);
  expect(twoSubjects.status, "score takes one subject").toBe(2);
});

test("a prompt that starts with a dash reaches the agent as the prompt", async () => {
  const box = sandbox();
  box.write("cases/dashed/prompt.md", "--help me\n");
  box.write("cases/dashed/case.json", {
    checks: [{ type: "output_contains", text: '"prompt":"--help me"' }],
  });
  const cases = path.join(box.root, "cases");
  const outDir = path.join(box.root, "results");

  const result = await box.cli([
    "score",
    "--subject",
    "none",
    "--cases",
    cases,
    "--reps",
    "1",
    "--out",
    outDir,
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(
    /^Suite score: 1\.00 \(1 of 1 cases, 1 of 1 runs\)$/m,
  );
});
