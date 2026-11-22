import path from "node:path";
import { expect, test } from "vitest";
import type { FakeScript } from "./testing/plant.js";
import { MAIN_AGENT } from "./agents.js";
import { plantCase, plugin, script, skillsFolder } from "./testing/plant.js";
import { scoreSubject } from "./testing/runs.js";
import { readResults, sandbox, seenBy } from "./testing/sandbox.js";

const COPY_UNDER_TEST = "the copy under test\n";

/**
 * Runs the one case "use greet", with a skill `greet` installed in the user's real home.
 * @param args - Builds the command and its subject flags from the skills folder under test.
 * @param hideSkills - Makes the fake harness report no skills at startup.
 * @returns What the command did and wrote.
 */
async function greetRun(args: (mine: string) => string[], hideSkills = false) {
  const box = sandbox();
  if (hideSkills) box.write("fake/hide-skills", "");
  const mine = skillsFolder(box, "mine", { greet: COPY_UNDER_TEST });
  // The sandbox root is the real home of the command, so this is a globally installed skill.
  box.write(".claude/skills/greet/SKILL.md", "the global copy\n");
  box.write(".claude/.credentials.json", "a login");
  box.write("cases/hello/prompt.md", "use greet to say hello\n");
  box.write("cases/hello/case.json", {
    checks: [{ type: "skill_loaded", skill: "greet" }],
  });
  const outDir = path.join(box.root, "results");
  const flags = ["--cases", path.join(box.root, "cases"), "--reps", "1"];
  const result = await box.cli([...args(mine), ...flags, "--out", outDir]);
  return { box, result, ...readResults(outDir) };
}

test("a globally installed skill of the same name does not load, and the user's login is copied", async () => {
  const { box, result, records } = await greetRun((mine) => [
    "score",
    "--subject",
    mine,
  ]);
  expect(result.status, result.stderr).toBe(0);
  const seen = seenBy(records[0]?.finalText ?? "");
  expect(seen.skills).toEqual({ greet: COPY_UNDER_TEST });
  expect(seen.home.startsWith(box.root)).toBe(false);
  expect(seen.credentials).toBe("a login");
  expect(records[0]?.subjectLoaded).toBe(true);
});

test("run --a none --b <skills dir> reports the no-skills baseline as A", async () => {
  const { result, records, subjects } = await greetRun((mine) => [
    "run",
    "--a",
    "none",
    "--b",
    mine,
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(
    subjects.map(({ label, kind, skills }) => ({ label, kind, skills })),
  ).toEqual([
    { label: "a", kind: "none", skills: [] },
    { label: "b", kind: "skills", skills: ["greet"] },
  ]);
  expect(
    records.map((record) => [
      record.subject,
      record.skillsLoaded,
      seenBy(record.finalText).skills,
      record.score,
    ]),
  ).toEqual([
    ["a", [], {}, 0],
    ["b", ["greet"], { greet: COPY_UNDER_TEST }, 1],
  ]);
  expect(result.stdout).toMatch(/^- A: no skills$/m);
  expect(result.stdout).toMatch(/`skill_loaded greet` A 0\/1, B 1\/1/);
  expect(result.stdout).toMatch(
    /^Suite score: 0\.00 \/ 1\.00 \(\+1\.00\) \(1 of 1 cases\)$/m,
  );
});

test("a run whose harness lists none of the subject's skills is invalid", async () => {
  const { result, records } = await greetRun(
    (mine) => ["score", "--subject", mine],
    true,
  );
  expect(result.status).toBe(1);
  expect(records[0]?.subjectLoaded).toBe(false);
  expect(records[0]?.score).toBeNull();
  expect(result.stdout).toMatch(
    /^- SUBJECT `hello` rep 1: the harness did not load the subject/m,
  );
});

type Steps = FakeScript["turns"][number];

const read = (file: string) => ({
  call: { name: "Read", input: { file_path: file } },
});
const bash = (command: string) => ({
  call: { name: "Bash", input: { command } },
});
const skillCall = (name: string) => ({
  call: { name: "Skill", input: { skill: name } },
});
// The fake harness fills `$CONFIG_DIR` with the run's own skills directory parent, where the adapter places copies.
const PLACED_FOO = "$CONFIG_DIR/skills/foo";
const FIXTURE = "skills/foo/SKILL.md";

/**
 * Plays one scripted agent against a skills folder that holds `foo`, with a workspace fixture that looks like a skill.
 * @param steps - What the agent does.
 * @param checks - The checks of the case.
 * @param more - `subject` replaces the skills folder (`none` loads nothing); `init` replaces fields of the init event.
 * @param more.subject - The `--subject` value.
 * @param more.init - Fields of the init event.
 * @param more.initOmit - Init fields to leave out.
 * @returns The record of the run.
 */
async function played(
  steps: Steps,
  checks: unknown[],
  more: {
    subject?: string;
    init?: Record<string, unknown>;
    initOmit?: "skills"[];
  } = {},
) {
  const box = sandbox();
  script(box, "run", {
    ...(more.init && { init: more.init }),
    ...(more.initOmit && { initOmit: more.initOmit }),
    turns: [[...steps, { final: "done" }]],
  });
  const mine = skillsFolder(box, "mine", { foo: "# foo\n" });
  box.write("mine/foo/references/bug-fix.md", "playbook\n");
  const cases = plantCase(box, checks);
  box.write("cases/restate/workspace/skills/foo/SKILL.md", "a fixture\n");
  const ran = await scoreSubject(box, {
    subject: more.subject ?? mine,
    cases,
  });
  expect(ran.status, ran.stderr).toBe(0);
  const [record] = ran.records;
  if (!record) throw new Error("no record");
  return record;
}
const scoresOf = (record: { checks: { score: number | null }[] }) =>
  record.checks.map(({ score }) => score);
const FOO = { type: "skill_loaded", skill: "foo" };

test("a fixture path that looks like a skill file is not a load", async () => {
  const record = await played(
    [read(FIXTURE), bash(`cat ${FIXTURE}`)],
    [FOO, { type: "skill_not_loaded", skill: "foo" }],
  );
  expect(scoresOf(record)).toEqual([0, 1]);
  expect(record.skillEvents).toEqual([]);
  expect(record.skillsLoaded).toEqual([]);
});

test("a grep across skills is not a load, and a cat of the skill is, through shell_read only", async () => {
  const grep = await played(
    [bash(`grep -r x ${PLACED_FOO}/SKILL.md`), bash(`ls ${PLACED_FOO}`)],
    [FOO],
  );
  expect(scoresOf(grep)).toEqual([0]);
  const cat = await played(
    [bash(`cat ${PLACED_FOO}/SKILL.md`), bash(`cat ${FIXTURE}`)],
    [FOO, { ...FOO, via: "shell_read" }, { ...FOO, via: "skill_tool" }],
  );
  expect(scoresOf(cat)).toEqual([1, 1, 0]);
  expect(cat.skillEvents).toMatchObject([
    { skill: "foo", via: "shell_read", index: 0, resolved: true, type: "load" },
  ]);
  expect(cat.skillsLoaded).toEqual(["foo"]);
});

test("reading the placed copy's SKILL.md is a load via file_read", async () => {
  const record = await played(
    [read(`${PLACED_FOO}/SKILL.md`)],
    [
      FOO,
      { ...FOO, via: ["file_read", "skill_tool"] },
      { ...FOO, via: "shell_read" },
    ],
  );
  expect(scoresOf(record)).toEqual([1, 1, 0]);
  expect(record.skillEvents[0]).toMatchObject({
    via: "file_read",
    type: "load",
  });
});

test("the none arm calling the skill tool with a name is an unresolved skill_tool event", async () => {
  const record = await played(
    [skillCall("foo")],
    [
      FOO,
      { ...FOO, resolved: true },
      { type: "skill_not_loaded", skill: "foo" },
    ],
    { subject: "none" },
  );
  expect(scoresOf(record)).toEqual([1, 0, 0]);
  expect(record.skillEvents).toEqual([
    {
      skill: "foo",
      via: "skill_tool",
      index: 0,
      resolved: false,
      type: "load",
      agent: MAIN_AGENT,
    },
  ]);
});

test("skill_available reads the listing; a harness without one is not applicable", async () => {
  const listed = await played(
    [],
    [
      { type: "skill_available", skill: "foo" },
      { type: "skill_not_available", skill: "foo" },
      { type: "skill_available", skill: "bar" },
      { type: "skill_not_available", skill: "bar" },
    ],
    { init: { skills: ["foo"] } },
  );
  expect(scoresOf(listed)).toEqual([1, 0, 0, 1]);
  const box = sandbox();
  const cases = plantCase(box, [{ type: "skill_available", skill: "foo" }]);
  const out = path.join(box.root, "results");
  const ran = await box.cli(
    [
      ...["score", "--subject", "none", "--reps", "1", "--out", out],
      ...["--cases", cases, "--harness", "claude-code,pi"],
    ],
    { SKILL_EVALS_BIN_PI: box.pi },
  );
  expect(ran.status, ran.stderr).toBe(0);
  const results = readResults(out);
  expect(results.notApplicable.map(({ missing }) => missing)).toEqual([
    ["skillListing"],
  ]);
});

test("skill_file_read sees references/bug-fix.md, through a read or a shell read", async () => {
  const checks = [
    { type: "skill_file_read", skill: "foo", path: "references/*.md" },
    { type: "skill_file_read", skill: "foo", path: "playbooks/*.md" },
    {
      type: "skill_file_read",
      skill: "foo",
      path: "references/bug-fix.md",
      via: "shell_read",
    },
    { type: "skill_file_read", skill: "bar", path: "references/*.md" },
  ];
  const viaRead = await played(
    [read(`${PLACED_FOO}/references/bug-fix.md`)],
    checks,
  );
  expect(scoresOf(viaRead)).toEqual([1, 0, 0, 0]);
  expect(viaRead.skillEvents).toEqual([
    {
      skill: "foo",
      via: "file_read",
      index: 0,
      resolved: true,
      type: "file_read",
      file: "references/bug-fix.md",
      agent: MAIN_AGENT,
    },
  ]);
  expect(viaRead.skillsLoaded).toEqual([]);
  const viaShell = await played(
    [bash(`head -20 '${PLACED_FOO}/references/bug-fix.md'`)],
    checks,
  );
  expect(scoresOf(viaShell)).toEqual([1, 0, 1, 0]);
});

test("under --lenient the 0.0.1 rule applies to a skill_loaded without a new field", async () => {
  const box = sandbox();
  script(box, "run", { turns: [[bash(`cat ${FIXTURE}`), { final: "done" }]] });
  const mine = skillsFolder(box, "mine", { foo: "# foo\n" });
  const cases = plantCase(box, [FOO, { ...FOO, via: "file_read" }]);
  box.write("cases/restate/workspace/skills/foo/SKILL.md", "a fixture\n");
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    ...["score", "--subject", mine, "--cases", cases, "--reps", "1"],
    ...["--out", out, "--lenient"],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  expect(scoresOf(readResults(out).records[0] ?? { checks: [] })).toEqual([
    1, 0,
  ]);
});

test("a plugin subject's skill is loaded by reading its SKILL.md in the plugin directory the harness was given", async () => {
  const box = sandbox();
  script(box, "run", {
    turns: [[read("$PLUGIN_DIR/skills/foo/SKILL.md"), { final: "done" }]],
  });
  const kit = plugin(box, "kit", {});
  box.write("kit/skills/foo/SKILL.md", "# foo\n");
  const ran = await scoreSubject(box, {
    subject: kit,
    cases: plantCase(box, [FOO, { ...FOO, via: "shell_read" }]),
  });
  expect(ran.status, ran.stderr).toBe(0);
  expect(scoresOf(ran.records[0] ?? { checks: [] })).toEqual([1, 0]);
  expect(ran.records[0]?.skillEvents[0]).toMatchObject({ via: "file_read" });
});

test("a harness that reported no skills fails both listing checks", async () => {
  const record = await played(
    [],
    [
      { type: "skill_available", skill: "foo" },
      { type: "skill_not_available", skill: "foo" },
    ],
    { initOmit: ["skills"] },
  );
  expect(scoresOf(record)).toEqual([0, 0]);
  expect(record.checks.map(({ reason }) => reason)).toEqual([
    "the harness did not report its skills",
    "the harness did not report its skills",
  ]);
});
