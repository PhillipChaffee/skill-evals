import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { plugin } from "./testing/plant.js";
import { exec, play, scoreSubject, writeCase } from "./testing/runs.js";
import { sandbox } from "./testing/sandbox.js";

const KIT = "kit";
const SKILL = "kit/skills/x/SKILL.md";
const TREE = "tree.txt";

test("a run cannot read cases committed inside the subject", async () => {
  const box = sandbox();
  const kit = plugin(box, KIT, {});
  box.write(SKILL, "original\n");
  writeCase(box, "kit/evals/cases", {
    id: "restate",
    checks: [
      { type: "file_matches", path: "found.txt", pattern: "^$" },
      { type: "file_matches", path: "listing.txt", pattern: "skills" },
    ],
  });
  box.write("kit/evals/cases/restate/grader/secret.txt", "answer");
  play(box, {
    name: "look",
    id: "restate",
    steps: [
      exec(
        'cd "$PLUGIN_DIR" && find . -name case.json > "$OLDPWD/found.txt"; ls > "$OLDPWD/listing.txt"',
      ),
    ],
  });

  const cases = path.join(kit, "evals/cases");
  const { status, stderr, records } = await scoreSubject(box, {
    subject: kit,
    cases,
  });
  expect(status, stderr).toBe(0);
  expect(records[0]?.checks.map((check) => check.score)).toEqual([1, 1]);
});

test("every run copy lives under a name that gives the agent no hint", async () => {
  const box = sandbox();
  const kit = plugin(box, KIT, {});
  box.write(SKILL, "original\n");
  writeCase(box, "cases", {
    id: "restate",
    checks: [
      { type: "file_matches", path: "where.txt", pattern: "/kit-\\w+\\s*$" },
    ],
  });
  play(box, {
    name: "where",
    id: "restate",
    steps: [exec('echo "$PLUGIN_DIR" > where.txt')],
  });
  const { records } = await scoreSubject(box, {
    subject: kit,
    cases: path.join(box.root, "cases"),
  });
  expect(records[0]?.checks[0]?.score).toBe(1);
});

/**
 * Plants a plugin with one skill, one case that edits the skill and one case that does not.
 * @returns The sandbox, the plugin, its skill file, and the cases directory.
 */
function editing() {
  const box = sandbox();
  const kit = plugin(box, KIT, {});
  const skill = box.write(SKILL, "original\n");
  writeCase(box, "cases", {
    id: "edits",
    checks: [{ type: "subject_unchanged" }],
  });
  writeCase(box, "cases", {
    id: "clean",
    checks: [{ type: "subject_unchanged" }],
  });
  const write = { path: "$PLUGIN_DIR/skills/x/SKILL.md", content: "edited\n" };
  play(box, {
    name: "edits",
    id: "edits",
    steps: [{ call: { name: "Write", input: {}, write } }],
  });
  play(box, { name: "clean", id: "clean", steps: [] });
  return { box, kit, skill, cases: path.join(box.root, "cases") };
}

test("an edit to the loaded subject does not reach the source directory", async () => {
  const { box, kit, skill, cases } = editing();
  const { status, stderr, records } = await scoreSubject(box, {
    subject: kit,
    cases,
  });
  expect(status, stderr).toBe(0);
  expect(fs.readFileSync(skill, "utf8")).toBe("original\n");
  const edits = records.find((record) => record.caseId === "edits");
  expect(edits?.subjectMutated).toBe(true);
  expect(edits?.subjectChanges?.modified).toContain("skills/x/SKILL.md");
  const clean = records.find((record) => record.caseId === "clean");
  expect([clean?.subjectMutated, clean?.subjectChanges]).toEqual([
    false,
    { created: [], modified: [], deleted: [] },
  ]);
});

test("subject_unchanged scores 0 for that run and 1 for a clean one", async () => {
  const { box, kit, cases } = editing();
  const { records } = await scoreSubject(box, { subject: kit, cases });
  const scores = Object.fromEntries(
    records.map((record) => [record.caseId, record.checks[0]?.score]),
  );
  expect(scores).toEqual({ edits: 0, clean: 1 });
  expect(records.find((r) => r.caseId === "edits")?.checks[0]).toMatchObject({
    reason: "changed: skills/x/SKILL.md",
  });
});

test("the none subject has nothing to change", async () => {
  const { box, cases } = editing();
  const { records } = await scoreSubject(box, { subject: "none", cases });
  expect(records.map((record) => record.subjectMutated)).toEqual([
    false,
    false,
  ]);
  expect(records.map((record) => record.subjectChanges)).toEqual([null, null]);
  expect(records.map((record) => record.checks[0]?.score)).toEqual([1, 1]);
});

test("the second rep starts from an unedited copy", async () => {
  const box = sandbox();
  const kit = plugin(box, KIT, {});
  box.write(SKILL, "original\n");
  writeCase(box, "cases", {
    id: "twice",
    checks: [{ type: "file_exists", path: "leaked.txt" }],
  });
  play(box, {
    name: "twice",
    id: "twice",
    steps: [
      exec(
        'test -e "$PLUGIN_DIR/marker" && echo left > leaked.txt; echo m > "$PLUGIN_DIR/marker"',
      ),
    ],
  });
  const { records } = await scoreSubject(box, {
    subject: kit,
    cases: path.join(box.root, "cases"),
    reps: 2,
  });
  expect(records.map((record) => record.checks[0]?.score)).toEqual([0, 0]);
  expect(records.map((record) => record.subjectChanges?.created)).toEqual([
    ["marker"],
    ["marker"],
  ]);
});

test("a hook that reads a file relative to the plugin root works from the copy", async () => {
  const box = sandbox();
  const kit = plugin(box, KIT, {});
  box.write("kit/skills/using-x/SKILL.md", "use x wisely\n");
  writeCase(box, "cases", {
    id: "reads",
    checks: [
      { type: "file_matches", path: "text.txt", pattern: "use x wisely" },
    ],
  });
  play(box, {
    name: "reads",
    id: "reads",
    steps: [exec('cat "$PLUGIN_DIR/skills/using-x/SKILL.md" > text.txt')],
  });
  const { records } = await scoreSubject(box, {
    subject: kit,
    cases: path.join(box.root, "cases"),
  });
  expect(records[0]).toMatchObject({ ok: true, subjectLoaded: true });
  expect(records[0]?.checks[0]?.score).toBe(1);
});

test("the config key subjectExclude keeps matching paths out of the copy", async () => {
  const box = sandbox();
  const kit = plugin(box, KIT, {});
  box.write(SKILL, "x\n");
  box.write("kit/notes/private.md", "private\n");
  box.write("kit/node_modules/dep/index.js", "dep\n");
  box.write("kit/.git/config", "git\n");
  box.write("skill-evals.config.json", { subjectExclude: ["notes/**"] });
  writeCase(box, "cases", {
    id: "look",
    checks: [{ type: "file_matches", path: TREE, pattern: "^skills\\s*$" }],
  });
  play(box, {
    name: "look",
    id: "look",
    steps: [
      exec(`ls -A "$PLUGIN_DIR" | grep -v -e plugin -e behavior > ${TREE}`),
    ],
  });
  const { records } = await scoreSubject(box, {
    subject: kit,
    cases: path.join(box.root, "cases"),
  });
  expect(records[0]?.checks[0]?.score).toBe(1);
});

test("an output directory inside the subject is left out of the copy", async () => {
  const box = sandbox();
  const kit = plugin(box, KIT, {});
  box.write(SKILL, "x\n");
  box.write("kit/out/old.txt", "old\n");
  writeCase(box, "cases", {
    id: "look",
    checks: [{ type: "file_matches", path: TREE, pattern: "^$" }],
  });
  play(box, {
    name: "look",
    id: "look",
    steps: [exec(`ls "$PLUGIN_DIR" | grep -x out > ${TREE}; true`)],
  });
  const out = path.join(kit, "out");
  const { status, stderr, records } = await scoreSubject(box, {
    subject: kit,
    cases: path.join(box.root, "cases"),
    out,
  });
  expect(status, stderr).toBe(0);
  expect(records[0]?.checks[0]?.score).toBe(1);
  expect(fs.existsSync(path.join(out, "old.txt"))).toBe(true);
});

test("a skills subject reaches the agent without its excluded paths", async () => {
  const box = sandbox();
  box.write("mine/greet/SKILL.md", "Say hello.\n");
  box.write("mine/greet/private/notes.md", "private\n");
  box.write("skill-evals.config.json", { subjectExclude: ["greet/private"] });
  writeCase(box, "cases", {
    id: "look",
    checks: [{ type: "file_matches", path: TREE, pattern: "^SKILL\\.md\\s*$" }],
  });
  play(box, {
    name: "look",
    id: "look",
    steps: [exec(`ls "$HOME/.claude/skills/greet" > ${TREE}`)],
  });
  const { status, stderr, records } = await scoreSubject(box, {
    subject: path.join(box.root, "mine"),
    cases: path.join(box.root, "cases"),
  });
  expect(status, stderr).toBe(0);
  expect(records[0]?.checks[0]?.score).toBe(1);
});
