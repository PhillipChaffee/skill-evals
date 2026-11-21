import path from "node:path";
import { expect, test } from "vitest";
import { skillsFolder } from "./testing/plant.js";
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
  expect(result.stdout).toMatch(/^Suite score: 0\.00 \/ 1\.00 \(\+1\.00\)$/m);
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
