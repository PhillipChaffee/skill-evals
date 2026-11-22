import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { apiCase } from "./testing/judged.js";
import { reply } from "./testing/judge-server.js";
import { plugin } from "./testing/plant.js";
import { exec, play, writeCase } from "./testing/runs.js";
import { gitRepo, readResults, sandbox } from "./testing/sandbox.js";
import {
  SUMMARY,
  keepStarts,
  linesIn,
  plantSuite,
  startsOf,
} from "./testing/suite.js";

const ids = ["alpha", "bravo", "charlie"];
const RUNS = "results.jsonl";
const REUSED = /\(reused\)/g;

test("a resume into an output directory inside the subject reuses runs, and the agent never sees the results", async () => {
  const box = sandbox();
  const kit = plugin(box, "kit", {});
  const listing = (id: string): string =>
    path.join(box.root, `listing-${id}.txt`);
  for (const id of ids) {
    writeCase(box, "suite", { id, checks: [SUMMARY] });
    play(box, {
      name: id,
      id,
      steps: [
        exec(
          `mkdir -p out; echo summary > out/summary.txt; ls -A "$PLUGIN_DIR" > ${listing(id)}`,
        ),
      ],
    });
  }
  const out = path.join(kit, "results");
  const args = [
    "--subject",
    kit,
    "--cases",
    path.join(box.root, "suite"),
    "--reps",
    "1",
  ];
  const first = await box.cli(["score", ...args, "--out", out]);
  expect(first.status, first.stderr).toBe(0);
  // The interruption: the last run is lost.
  const file = path.join(out, RUNS);
  fs.writeFileSync(file, `${linesIn(out).slice(0, 2).join("\n")}\n`);
  keepStarts(box, 2);
  const second = await box.cli(["score", ...args, "--resume", out]);
  expect(second.status, second.stderr).toBe(0);
  expect(second.stderr).not.toContain("changed during the run");
  expect(second.stderr.match(REUSED)).toHaveLength(2);
  expect(startsOf(box)).toBe(3);
  for (const id of ids) {
    expect(fs.readFileSync(listing(id), "utf8"), id).not.toMatch(/results/);
  }
  expect(readResults(out).records).toHaveLength(3);
});

test("a resume whose directory is the subject is refused as a fresh run is", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  const kit = plugin(box, "kit", {});
  const args = ["score", "--subject", kit, "--cases", cases, "--reps", "1"];
  box.write("kit/results.jsonl", "");
  const ran = await box.cli([...args, "--resume", kit]);
  expect(ran.status).toBe(2);
  expect(ran.stderr).toContain("is the subject directory");
});

test("a ref is keyed by what its export holds, so a changed subjectExclude re-runs", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  box.write("one/SKILL.md", "skill\n");
  box.write("notes/extra.txt", "extra\n");
  const git = gitRepo(box.root);
  git("add", "one", "notes");
  git("commit", "-q", "-m", "skill");
  const out = path.join(box.root, "results");
  const args = ["--subject", "HEAD", "--cases", cases, "--reps", "1"];
  await box.cli(["score", ...args, "--out", out]);
  await box.cli(["score", ...args, "--resume", out]);
  expect(startsOf(box)).toBe(1);
  box.write("skill-evals.config.json", { subjectExclude: ["notes/**"] });
  await box.cli(["score", ...args, "--resume", out]);
  expect(startsOf(box)).toBe(2);
  // Nothing changed since: reused.
  await box.cli(["score", ...args, "--resume", out]);
  expect(startsOf(box)).toBe(2);
});

test("a prompt edited and edited back is run each time, for the files of an older run may be gone", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids);
  const out = path.join(box.root, "results");
  const args = ["--subject", "none", "--cases", cases, "--reps", "1"];
  await box.cli(["score", ...args, "--out", out]);
  const prompt = path.join(box.root, "suite/bravo/prompt.md");
  const original = fs.readFileSync(prompt, "utf8");
  fs.writeFileSync(prompt, "something else\n");
  await box.cli(["score", ...args, "--resume", out]);
  expect(startsOf(box)).toBe(4);
  fs.writeFileSync(prompt, original);
  const back = await box.cli(["score", ...args, "--resume", out]);
  // Its record is the old one, but a later run wrote the files that record points at, so the run is made again.
  expect(startsOf(box)).toBe(5);
  expect(back.stderr.match(REUSED)).toHaveLength(2);
  const again = await box.cli(["score", ...args, "--resume", out]);
  expect(startsOf(box)).toBe(5);
  expect(again.stderr.match(REUSED)).toHaveLength(3);
});

test("a resume gives each rep its own judge answers", async () => {
  const { run, out } = await apiCase({ rubric: "It names the fix." }, [
    reply('{"reason": "a", "score": 1}'),
    reply('{"reason": "b", "score": 0}'),
    reply('{"reason": "c", "score": 1}'),
  ]);
  const first = await run(["--reps", "3"]);
  expect(first.ran.status, first.ran.stderr).toBe(0);
  const scores = (): (number | null | undefined)[] =>
    readResults(out).records.map((record) => record.checks[0]?.score);
  expect(scores()).toEqual([1, 0, 1]);
  // Every run is lost, and only the judge cache remains.
  fs.writeFileSync(path.join(out, RUNS), "");
  const again = await run(["--reps", "3", "--resume", out]);
  expect(again.ran.status, again.ran.stderr).toBe(0);
  expect(scores()).toEqual([1, 0, 1]);
  expect(readResults(out).records.map((record) => record.judge?.calls)).toEqual(
    [0, 0, 0],
  );
});

test("a harness that was updated, or a passed variable that changed, re-runs", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  box.write("skill-evals.config.json", { env: ["MY_SETTING"] });
  const out = path.join(box.root, "results");
  const args = [
    "--subject",
    "none",
    "--cases",
    cases,
    "--reps",
    "1",
    "--model",
    "m",
  ];
  await box.cli(["score", ...args, "--out", out], { MY_SETTING: "one" });
  await box.cli(["score", ...args, "--resume", out], { MY_SETTING: "one" });
  expect(startsOf(box)).toBe(1);
  await box.cli(["score", ...args, "--resume", out], { MY_SETTING: "two" });
  expect(startsOf(box)).toBe(2);
  const launcher = path.join(box.root, "bin/fake-agent.mjs");
  fs.appendFileSync(launcher, "// updated\n");
  await box.cli(["score", ...args, "--resume", out], { MY_SETTING: "two" });
  expect(startsOf(box)).toBe(3);
});

test("--resume without --model warns once, and with it does not", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  const out = path.join(box.root, "results");
  const args = ["--subject", "none", "--cases", cases, "--reps", "1"];
  await box.cli(["score", ...args, "--out", out]);
  const bare = await box.cli(["score", ...args, "--resume", out]);
  expect(bare.stderr.match(/--resume without --model/g)).toHaveLength(1);
  const named = await box.cli([
    "score",
    ...args,
    "--model",
    "m",
    "--resume",
    out,
  ]);
  expect(named.stderr).not.toContain("without --model");
});

test("a malformed record in the middle of the file is a usage error, never a crash", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ids);
  const out = path.join(box.root, "results");
  const args = ["--subject", "none", "--cases", cases, "--reps", "1"];
  await box.cli(["score", ...args, "--out", out]);
  const lines = linesIn(out).map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  lines[0] = { ...lines[0], checks: [null] };
  fs.writeFileSync(
    path.join(out, RUNS),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  const ran = await box.cli(["score", ...args, "--resume", out]);
  expect(ran.status).toBe(2);
  expect(ran.stderr).toContain("line 1 is not a valid run record");
});
