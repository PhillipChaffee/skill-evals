import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { HARNESSES } from "./harnesses/index.js";
import { skillEvents, skillsLoaded } from "./skill-events.js";
import { fixture } from "./testing/sandbox.js";
import { parseText } from "./testing/streams.js";

const CLAUDE_CODE = "claude-code";
const SKILL_MD = "SKILL.md";
const harnessOf = (id: string) => {
  const found = HARNESSES.find((harness) => harness.id === id);
  if (!found) throw new Error(`no harness ${id}`);
  return found;
};

/**
 * Plays a captured stream against a real subject on disk, wired as a run wires it: the per-run copy's skill
 * directories plus the copies the adapter placed, including those it finds after its setup.
 * @param id - The harness.
 * @param name - The capture's file name.
 * @returns The skills the run loaded.
 */
function skillsLoadedBy(id: string, name: string): string[] {
  const harness = harnessOf(id);
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-")));
  onTestFinished(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  const kit = path.join(base, "kit");
  const home = path.join(base, "home");
  const skill = (dir: string): string => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SKILL_MD), "bro\n");
    return dir;
  };
  // The captures read the skill from the paths of the run that made them; the test's own directories replace them.
  const text = fs
    .readFileSync(fixture(name), "utf8")
    .replaceAll("/work/kit-9fq1", kit)
    .replaceAll("/tmp/home-4c1d", home);
  const skillDirs = { bro: skill(path.join(kit, "skills/bro")) };
  let placed: Record<string, string> = {};
  if (id === "codex") {
    skill(
      path.join(home, ".codex/plugins/cache/magic-dev/magic/0.2.0/skills/bro"),
    );
    fs.mkdirSync(path.join(kit, ".agents/plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(kit, ".agents/plugins/marketplace.json"),
      JSON.stringify({ name: "magic-dev", plugins: [{ name: "magic" }] }),
    );
    const subject = {
      kind: "plugin" as const,
      dir: kit,
      skills: ["bro"],
      skillDirs,
    };
    placed =
      harness.placedAfterSetup?.({
        subject,
        home,
        workspace: base,
        prompt: "",
      }) ?? {};
  }
  return skillsLoaded(
    skillEvents(
      parseText(id, text).toolCalls,
      { skillDirs, placed },
      {
        home,
        workspace: base,
        pathOf: harness.pathOf,
        skillOf: harness.skillOf,
      },
    ),
  );
}

test.each([
  [CLAUDE_CODE, "claude-code.stream.jsonl", ["bro"]],
  ["pi", "pi.stream.jsonl", ["bro"]],
  ["opencode", "opencode.stream.jsonl", ["bro"]],
  ["codex", "codex.stream.jsonl", ["bro"]],
  ["cursor", "cursor.stream.jsonl", []],
])("%s: the captured stream loads the skills %j", (id, name, expected) => {
  expect(skillsLoadedBy(id, name)).toEqual(expected);
});

test.each([
  [CLAUDE_CODE, { file_path: "/a/SKILL.md" }, "/a/SKILL.md"],
  ["pi", { path: "/b/SKILL.md" }, "/b/SKILL.md"],
  ["cursor", { path: "c/SKILL.md" }, "c/SKILL.md"],
  ["opencode", { filePath: "/d/SKILL.md" }, "/d/SKILL.md"],
  ["opencode", { path: "/e/SKILL.md" }, "/e/SKILL.md"],
  [CLAUDE_CODE, { path: "/f/SKILL.md" }, null],
  [CLAUDE_CODE, { file_path: "" }, null],
  ["pi", "/g/SKILL.md", null],
  ["codex", { command: "cat /h/SKILL.md" }, null],
])("%s pathOf reads the path of a read call from %j", (id, input, expected) => {
  const call = { name: "read", kind: "read" as const, input };
  expect(harnessOf(id).pathOf(call)).toBe(expected);
});

test("codex finds the skills of its installed plugin in its cache after setup, and tolerates a missing cache", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cx-")));
  onTestFinished(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  const kit = path.join(base, "kit");
  fs.mkdirSync(path.join(kit, ".agents/plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(kit, ".agents/plugins/marketplace.json"),
    JSON.stringify({ name: "mk", plugins: [{ name: "pl" }] }),
  );
  const home = path.join(base, "home");
  const subject = {
    kind: "plugin" as const,
    dir: kit,
    skills: [],
    skillDirs: {},
  };
  const input = { subject, home, workspace: base, prompt: "" };
  const hook = harnessOf("codex").placedAfterSetup;
  expect(hook?.(input)).toEqual({});
  const cache = path.join(home, ".codex/plugins/cache/mk/pl");
  for (const version of ["0.1.0", "0.2.0"]) {
    fs.mkdirSync(path.join(cache, version, "skills/bro"), { recursive: true });
  }
  fs.mkdirSync(path.join(cache, "0.1.0/skills/old"), { recursive: true });
  expect(hook?.(input)).toEqual({
    bro: path.join(cache, "0.2.0/skills/bro"),
    old: path.join(cache, "0.1.0/skills/old"),
  });
  expect(hook?.({ ...input, subject: null })).toEqual({});
});
