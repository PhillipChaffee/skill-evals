import fs from "node:fs";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { loadCases } from "./cases.js";
import type { Case } from "./cases.js";
import { caseHash, runKey, toolVersion } from "./run-key.js";
import type { RunPlan } from "./run-plan.js";
import { resolveSubject } from "./subject.js";
import { gitRepo, sandbox } from "./testing/sandbox.js";
import { SUMMARY } from "./testing/suite.js";

/**
 * Plants a case with every directory a case can have.
 * @returns The sandbox, and a function that loads the case.
 */
function planted() {
  const box = sandbox();
  box.write("cases/one/prompt.md", "say it\n");
  box.write("cases/one/case.json", {
    checks: [SUMMARY],
    fixtures: ["../_shared"],
    home: "home",
  });
  box.write("cases/one/workspace/notes.txt", "notes\n");
  box.write("cases/one/grader/check.sh", "exit 0\n");
  box.write("cases/one/home/.rc", "rc\n");
  box.write("cases/_shared/data.txt", "data\n");
  const load = (): Case => loadCases(path.join(box.root, "cases"))[0] as Case;
  return { box, load };
}

test("a case hash follows the case file, the directory, the shared fixtures and the grader", () => {
  const { box, load } = planted();
  const base = caseHash(load());
  expect(caseHash(load())).toBe(base);
  const changes: [string, unknown][] = [
    ["cases/one/prompt.md", "say it differently\n"],
    ["cases/one/workspace/notes.txt", "other\n"],
    ["cases/one/grader/check.sh", "exit 1\n"],
    ["cases/one/home/.rc", "other\n"],
    ["cases/_shared/data.txt", "other\n"],
    ["cases/one/workspace/new.txt", "new\n"],
    [
      "cases/one/case.json",
      { checks: [SUMMARY], fixtures: ["../_shared"], home: "home", weight: 2 },
    ],
  ];
  for (const [file, content] of changes) {
    const before = fs.existsSync(path.join(box.root, file))
      ? fs.readFileSync(path.join(box.root, file), "utf8")
      : null;
    box.write(file, content);
    expect(caseHash(load()), file).not.toBe(base);
    if (before === null) fs.rmSync(path.join(box.root, file));
    else box.write(file, before);
    expect(caseHash(load()), file).toBe(base);
  }
});

test("a case hash does not depend on where the checkout is", () => {
  const { box, load } = planted();
  const here = caseHash(load());
  fs.cpSync(path.join(box.root, "cases"), path.join(box.root, "moved/cases"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  const there = loadCases(path.join(box.root, "moved/cases"))[0] as Case;
  expect(caseHash(there)).toBe(here);
});

test("a link is hashed by its target text and is not followed", () => {
  const { box, load } = planted();
  fs.symlinkSync("notes.txt", path.join(box.root, LINK));
  const first = caseHash(load());
  fs.rmSync(path.join(box.root, LINK));
  fs.symlinkSync("missing.txt", path.join(box.root, LINK));
  expect(caseHash(load())).not.toBe(first);
});

test("a case built by hand, with no directory, still has a hash", () => {
  const { load } = planted();
  const { dir, ...rest } = load();
  expect(dir).toBeDefined();
  expect(caseHash(rest as Case)).toMatch(/^[0-9a-f]{64}$/);
});

const LINK = "cases/one/workspace/link";
const harness = (id: string) => ({ id }) as RunPlan["harness"];
const PLAN = {
  harness: harness("h"),
  subject: { revision: "r1" },
  rep: 1,
  model: "m",
  judge: { harness: harness("j"), model: "jm" },
  decision: null,
  isolated: false,
  lenient: false,
} as unknown as Omit<RunPlan, "caseDef">;

test("a run key changes with every part that decides the result, and with nothing else", () => {
  const { load } = planted();
  const caseDef = load();
  const keyOf = (change: Partial<RunPlan> = {}): string =>
    runKey({ ...PLAN, caseDef, ...change });
  const base = keyOf();
  expect(keyOf()).toBe(base);
  expect(keyOf({ pass: ["X"], outDir: "elsewhere" })).toBe(base);
  const changed: Partial<RunPlan>[] = [
    { harness: harness("other") },
    { subject: { revision: "r2" } as RunPlan["subject"] },
    { rep: 2 },
    { model: "m2" },
    { model: undefined },
    { judge: { harness: harness("k"), bin: "b", model: "jm" } },
    { judge: { harness: harness("j"), bin: "b", model: "jm2" } },
    { judge: { harness: harness("j") } as RunPlan["judge"] },
    { judgeApi: { kind: "anthropic", model: "a" } as RunPlan["judgeApi"] },
    { decisionModel: "d" },
    { isolated: true },
    { lenient: true },
  ];
  const keys = changed.map((change) => keyOf(change));
  expect(new Set([base, ...keys]).size).toBe(changed.length + 1);
  // With a judge API, the harness that would have judged does not matter.
  const api = { kind: "anthropic", model: "a" } as RunPlan["judgeApi"];
  expect(keyOf({ judgeApi: api })).toBe(
    keyOf({
      judgeApi: api,
      judge: { harness: harness("k") } as RunPlan["judge"],
    }),
  );
});

test("the tool version is the package version", () => {
  const { version } = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"),
  ) as { version: string };
  expect(toolVersion()).toBe(version);
});

test("the revision of a directory is the content hash of its export, of a ref the git tree, of none none", () => {
  const box = sandbox();
  box.write("one/SKILL.md", "first\n");
  const git = gitRepo(box.root);
  const project = { root: box.root, isGitRepo: true, cwd: box.root };
  const revisionOf = (spec: string): string => {
    const subject = resolveSubject("subject", spec, project);
    onTestFinished(subject.dispose);
    return subject.revision;
  };
  const dir = revisionOf(".");
  expect(revisionOf(".")).toBe(dir);
  expect(revisionOf("none")).toBe("none");
  git("add", "-A");
  git("commit", "-q", "-m", "kit");
  expect(revisionOf("HEAD")).toBe(git("rev-parse", "HEAD^{tree}"));
  box.write("one/SKILL.md", "second\n");
  expect(revisionOf(".")).not.toBe(dir);
});
