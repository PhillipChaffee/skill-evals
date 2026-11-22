import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { plugin } from "./testing/plant.js";
import { exec, play, scoreSubject, writeCase } from "./testing/runs.js";
import { gitRepo, sandbox } from "./testing/sandbox.js";
import { EXIT } from "./exit-codes.js";

const KIT = "kit";
const SKILL = "kit/skills/x/SKILL.md";
const TREE = "tree.txt";

test("a git-ref subject leaves out export-ignore paths", async () => {
  const box = sandbox();
  const repo = path.join(box.root, "repo");
  fs.mkdirSync(repo);
  plugin(box, "repo", {});
  box.write("repo/skills/x/SKILL.md", "x\n");
  box.write("repo/secret/answers.txt", "42\n");
  box.write("repo/.gitattributes", "secret/ export-ignore\n");
  box.write("repo/skill-evals.config.json", { reps: 1 });
  const git = gitRepo(repo);
  git("add", "-A");
  git("commit", "-q", "-m", "plugin");
  writeCase(box, "cases", {
    id: "look",
    checks: [{ type: "file_matches", path: TREE, pattern: "^x\\n0\\n0\\s*$" }],
  });
  play(box, {
    name: "look",
    id: "look",
    steps: [
      exec(
        `ls "$PLUGIN_DIR/skills" > ${TREE}; ls "$PLUGIN_DIR" | grep -c secret >> ${TREE}; ls "$PLUGIN_DIR" | grep -c skill-evals >> ${TREE}; true`,
      ),
    ],
  });
  const { status, stderr, records } = await scoreSubject(box, {
    subject: "trunk",
    cases: path.join(box.root, "cases"),
    cwd: repo,
  });
  expect(status, stderr).toBe(0);
  expect(records[0]?.subjectLoaded).toBe(true);
  expect(records[0]?.checks[0]?.score).toBe(1);
});

test("a link in the subject that points outside it is a load error", async () => {
  const box = sandbox();
  const kit = plugin(box, KIT, {});
  box.write(SKILL, "x\n");
  box.write("elsewhere/grader.txt", "g\n");
  fs.symlinkSync("../../elsewhere", path.join(kit, "skills/out"));
  writeCase(box, "cases", {
    id: "look",
    checks: [{ type: "subject_unchanged" }],
  });
  const { status, stderr } = await scoreSubject(box, {
    subject: kit,
    cases: path.join(box.root, "cases"),
  });
  expect(status).toBe(2);
  expect(stderr).toMatch(/links outside the subject/);
});

test("the subject directory changing during the run fails the command", async () => {
  const box = sandbox();
  const kit = plugin(box, KIT, {});
  const skill = box.write(SKILL, "original\n");
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

test("the config file of a project-root subject is not part of its copy", async () => {
  const box = sandbox();
  plugin(box, ".", {});
  box.write("skills/x/SKILL.md", "x\n");
  box.write("skill-evals.config.json", { reps: 1 });
  writeCase(box, "cases", {
    id: "look",
    checks: [{ type: "file_matches", path: TREE, pattern: "^0\\s*$" }],
  });
  play(box, {
    name: "look",
    id: "look",
    steps: [
      exec(`ls -A "$PLUGIN_DIR" | grep -c skill-evals.config > ${TREE}; true`),
    ],
  });
  const { status, stderr, records } = await scoreSubject(box, {
    subject: box.root,
    cases: path.join(box.root, "cases"),
  });
  expect(status, stderr).toBe(0);
  expect(records[0]?.checks[0]?.score).toBe(1);
});

test("an edit to the skills that the harness found in its home is seen by subject_unchanged", async () => {
  const box = sandbox();
  box.write("mine/greet/SKILL.md", "Say hello.\n");
  writeCase(box, "cases", {
    id: "edits",
    checks: [{ type: "subject_unchanged" }],
  });
  play(box, {
    name: "edits",
    id: "edits",
    steps: [exec('echo more >> "$HOME/.claude/skills/greet/SKILL.md"')],
  });
  const { records } = await scoreSubject(box, {
    subject: path.join(box.root, "mine"),
    cases: path.join(box.root, "cases"),
  });
  expect(records[0]?.checks[0]).toMatchObject({
    score: 0,
    reason: "changed: greet/SKILL.md",
  });
  expect(records[0]?.subjectChanges?.modified).toEqual(["greet/SKILL.md"]);
  expect(
    fs.readFileSync(path.join(box.root, "mine/greet/SKILL.md"), "utf8"),
  ).toBe("Say hello.\n");
});
