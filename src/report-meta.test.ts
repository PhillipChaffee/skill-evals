import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { dirtyOf, harnessVersions } from "./meta.js";
import { caseHash } from "./run-key.js";
import type { Subject } from "./subject.js";
import { scoreArgs, scriptedCase } from "./testing/budget.js";
import { gitRepo, readResults, sandbox } from "./testing/sandbox.js";

const RESULTS = "results";
const HARNESS = "claude-code";
const NEVER = { type: "output_contains", text: "never said" };

const versionsAsked = (box: { versions: string }): string[] =>
  fs.existsSync(box.versions)
    ? fs.readFileSync(box.versions, "utf8").trim().split("\n")
    : [];

test("each harness's version is read once for the command and is null when it fails", async () => {
  const box = sandbox();
  for (const id of ["alpha", "bravo"]) scriptedCase(box, id);
  const ran = await box.cli(
    scoreArgs(box, RESULTS, "--reps", "2", "--model", "m1"),
  );
  expect(ran.status, ran.stderr).toBe(0);
  expect(versionsAsked(box)).toEqual(["version"]);
  const { meta } = readResults(path.join(box.root, RESULTS));
  expect(meta.harnessVersions).toEqual({ [HARNESS]: "fake-harness 9.9.9" });
  // The fake harness did not count the question as a start.
  expect(fs.readFileSync(box.started, "utf8").trim().split("\n")).toHaveLength(
    4,
  );

  fs.rmSync(path.join(box.root, RESULTS), { recursive: true });
  const failing = await box.cli(scoreArgs(box, RESULTS), {
    FAKE_VERSION_FAIL: "1",
  });
  expect(failing.status, failing.stderr).toBe(0);
  expect(
    readResults(path.join(box.root, RESULTS)).meta.harnessVersions,
  ).toEqual({ [HARNESS]: null });
});

test("the judge harness's version is read only when a judged check is selected", async () => {
  const box = sandbox();
  scriptedCase(box, "alpha");
  const flags = ["--harness", HARNESS, "--judge-harness", "pi"];
  const env = { SKILL_EVALS_BIN_PI: box.pi };
  const plain = await box.cli(scoreArgs(box, RESULTS, ...flags), env);
  expect(plain.status, plain.stderr).toBe(0);
  expect(
    Object.keys(readResults(path.join(box.root, RESULTS)).meta.harnessVersions),
  ).toEqual([HARNESS]);

  box.write("suite/graded/prompt.md", "do graded\n");
  box.write("suite/graded/case.json", {
    checks: [{ type: "judge", rubric: "Is it fine?" }],
  });
  fs.rmSync(path.join(box.root, RESULTS), { recursive: true });
  const judged = await box.cli(
    scoreArgs(box, RESULTS, ...flags, "--max-invalid", "1"),
    env,
  );
  expect(judged.stderr).not.toContain("internal error");
  const { meta } = readResults(path.join(box.root, RESULTS));
  expect(Object.keys(meta.harnessVersions).sort()).toEqual([HARNESS, "pi"]);
});

test("a harness that outlasts the version limit is killed with its group, and reads null", async () => {
  const box = sandbox();
  const pid = path.join(box.root, "pid");
  const slow = box.write(
    "slow-version.mjs",
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pid)}, String(child.pid));
setInterval(() => {}, 1000);
`,
  );
  fs.chmodSync(slow, 0o755);
  const located = [{ harness: { id: "slow" }, bin: slow }] as never;
  const began = Date.now();
  expect(await harnessVersions(located, 300)).toEqual({ slow: null });
  expect(Date.now() - began).toBeLessThan(5000);
  const child = Number(fs.readFileSync(pid, "utf8"));
  const gone = (): boolean => {
    try {
      process.kill(child, 0);
      return false;
    } catch {
      return true;
    }
  };
  for (let tries = 0; tries < 40 && !gone(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(gone()).toBe(true);
});

test("plan, --dry-run and a usage error read no version and start no harness", async () => {
  const box = sandbox();
  scriptedCase(box, "alpha");
  for (const args of [
    ["plan", "--subject", "none", "--cases", path.join(box.root, "suite")],
    scoreArgs(box, RESULTS, "--dry-run"),
  ]) {
    const ran = await box.cli(args);
    expect(ran.status, ran.stderr).toBe(0);
  }
  const wrong = await box.cli(scoreArgs(box, RESULTS, "--max-invalid", "7"));
  expect(wrong.status).toBe(2);
  expect(versionsAsked(box)).toEqual([]);
  expect(fs.existsSync(box.started)).toBe(false);
});

test("caseHashes are the hashes that a run key uses: a check a harness dropped is not in them", async () => {
  const box = sandbox();
  scriptedCase(box, "whole");
  scriptedCase(box, "trimmed", {
    checks: [{ ...NEVER, requires: ["compact"], ifUnsupported: "skip" }],
  });
  const ran = await box.cli(scoreArgs(box, RESULTS));
  expect(ran.status, ran.stderr).toBe(0);
  const { meta, skippedChecks } = readResults(path.join(box.root, RESULTS));
  expect(skippedChecks).toHaveLength(1);
  const loaded = Object.fromEntries(
    loadCases(path.join(box.root, "suite")).map((one) => [
      one.id,
      caseHash(one),
    ]),
  );
  const hashes = meta.caseHashes[HARNESS];
  expect(hashes?.["whole"]).toBe(loaded["whole"]);
  expect(hashes?.["trimmed"]).not.toBe(loaded["trimmed"]);
});

test("meta names the tool, models, subject revision, case hashes and isolation", async () => {
  const box = sandbox();
  scriptedCase(box, "alpha");
  const ran = await box.cli(
    scoreArgs(box, RESULTS, "--model", "run-model", "--judge-model", "j-model"),
  );
  expect(ran.status, ran.stderr).toBe(0);
  const results = readResults(path.join(box.root, RESULTS));
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
    version: string;
  };
  const [alpha] = loadCases(path.join(box.root, "suite"));
  expect(results.schemaVersion).toBe(1);
  expect(results.meta).toMatchObject({
    toolVersion: pkg.version,
    models: { agent: "run-model", judge: "j-model", decision: null },
    caseHashes: { [HARNESS]: { alpha: caseHash(alpha as never) } },
    isolated: false,
    subjects: [{ label: "subject", revision: "none", dirty: null }],
  });
});

test("dirty is true for uncommitted changes under the subject, false for a clean tree or a ref, and null outside git", () => {
  const box = sandbox();
  const repo = path.join(box.root, "repo");
  fs.mkdirSync(repo);
  box.write("repo/skills/x/SKILL.md", "x\n");
  const git = gitRepo(repo);
  const subject = (dir: string | null, commit: string | null): Subject =>
    ({ dir, commit }) as Subject;
  expect(dirtyOf(subject(repo, null))).toBe(true);
  git("add", "-A");
  git("commit", "-q", "-m", "x");
  expect(dirtyOf(subject(repo, null))).toBe(false);
  // An ignored file is part of what a run could load, so it counts.
  box.write("repo/.gitignore", "ignored.txt\n");
  git("add", "-A");
  git("commit", "-q", "-m", "ignore");
  expect(dirtyOf(subject(repo, null))).toBe(false);
  box.write("repo/ignored.txt", "x\n");
  expect(dirtyOf(subject(repo, null))).toBe(true);
  fs.rmSync(path.join(repo, "ignored.txt"));
  box.write("repo/skills/x/SKILL.md", "changed\n");
  expect(dirtyOf(subject(path.join(repo, "skills"), null))).toBe(true);
  expect(dirtyOf(subject(repo, "abc123"))).toBe(false);
  const outside = path.join(box.root, "outside");
  fs.mkdirSync(outside);
  expect(dirtyOf(subject(outside, null))).toBeNull();
  expect(dirtyOf(subject(null, null))).toBeNull();
  expect(dirtyOf(subject(path.join(box.root, "missing"), null))).toBeNull();
});
