import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import type { ToolCall } from "./harnesses/shared.js";
import { shellWords } from "./shell-words.js";
import { legacySkillLoads, skillEvents, skillsLoaded } from "./skill-events.js";

const SKILL_MD = "SKILL.md";
const REFERENCE = "references/a.md";
const WORKSPACE_FIXTURE = "skills/foo/SKILL.md";
const shell = (command: string): ToolCall => ({
  name: "Bash",
  kind: "shell",
  input: { command },
});
const read = (file: string): ToolCall => ({
  name: "Read",
  kind: "read",
  input: { file_path: file },
});

/**
 * Makes a subject copy that holds the skill `foo` with a reference file, a workspace, and a home.
 * @returns The directories, and a function that lists the events of some calls.
 */
function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ev-")));
  onTestFinished(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  const dir = path.join(base, "kit");
  const foo = path.join(dir, "skills/foo");
  const workspace = path.join(base, "work");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(foo, "references"), { recursive: true });
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(foo, SKILL_MD), "foo\n");
  fs.writeFileSync(path.join(foo, REFERENCE), "a\n");
  const events = (calls: ToolCall[]) =>
    skillEvents(
      calls,
      { dir, skillDirs: { foo } },
      {
        home,
        workspace,
        pathOf: (call) => (call.input as { file_path: string }).file_path,
      },
    );
  return { base, dir, foo, workspace, home, events };
}

const via = (events: { via: string }[]) => events.map((event) => event.via);

test("shellWords splits at &&, ||, ;, | and newlines outside quotes, and unquotes words", () => {
  expect(
    shellWords(`cd x && cat 'a b' | head -n 1; echo "q;r" || ls\nwc -l`),
  ).toEqual([
    ["cd", "x"],
    ["cat", "a b"],
    ["head", "-n", "1"],
    ["echo", "q;r"],
    ["ls"],
    ["wc", "-l"],
  ]);
  expect(shellWords(String.raw`cat a\ b "c\"d" '' "e\n"`)).toEqual([
    ["cat", "a b", `c"d`, "", String.raw`e\n`],
  ]);
  expect(shellWords("cat 'unclosed path")).toEqual([["cat", "unclosed path"]]);
  expect(shellWords("")).toEqual([]);
});

test("a read-kind call of SKILL.md is a file_read load, and a file under the directory is a file_read event with its relative path", () => {
  const { foo, events } = world();
  const found = events([
    read(path.join(foo, SKILL_MD)),
    read(path.join(foo, REFERENCE)),
    read(path.join(foo, "skill.MD")),
    read(path.join(foo, "references")),
  ]);
  expect(found.map(({ type, file, index }) => [type, file, index])).toEqual([
    ["load", undefined, 0],
    ["file_read", "references/a.md", 1],
    ["load", undefined, 2],
  ]);
  expect(skillsLoaded(found)).toEqual(["foo"]);
});

test("only a read command of a shell call reads: cat, head, tail, less, bat, nl and sed -n count; grep, rg, ls, find and wc do not", () => {
  const { foo, events } = world();
  const file = path.join(foo, SKILL_MD);
  const reads = [
    `cat ${file}`,
    `head -20 ${file}`,
    `tail -5 "${file}"`,
    `less ${file}`,
    `bat ${file}`,
    `nl ${file}`,
    `sed -n '1,10p' ${file}`,
    `FOO=1 BAR=2 cat ${file}`,
    `cd /tmp && /usr/bin/cat '${file}' | wc -l`,
    `/bin/bash -lc 'cat ${file}'`,
    `sh -c "echo hi; head ${file}"`,
  ];
  const not = [
    `grep -r x ${file}`,
    `rg x ${file}`,
    `ls ${file}`,
    `find ${path.dirname(file)} -name SKILL.md`,
    `wc -l ${file}`,
    `sed s/a/b/ ${file}`,
    `echo ${file}`,
    `bash script.sh ${file}`,
    `bash -c`,
  ];
  expect(via(events(reads.map(shell)))).toEqual(reads.map(() => "shell_read"));
  expect(events(not.map(shell))).toEqual([]);
});

test("a path resolves against the workspace, through ~ and $HOME, and through links; a workspace look-alike never counts", () => {
  const { foo, workspace, home, events, base } = world();
  fs.symlinkSync(foo, path.join(base, "link"));
  fs.mkdirSync(path.join(workspace, "skills/foo"), { recursive: true });
  fs.writeFileSync(path.join(workspace, WORKSPACE_FIXTURE), "fixture\n");
  fs.symlinkSync(foo, path.join(home, "foo"));
  const found = events([
    shell(`cat ${path.join(base, "link/SKILL.md")}`),
    shell("cat ~/foo/SKILL.md"),
    shell("cat $HOME/foo/SKILL.md"),
    shell("cat ${HOME}/foo/references/a.md"),
    read(path.relative(workspace, path.join(foo, SKILL_MD))),
    read("skills/foo/SKILL.md"),
    shell("cat skills/foo/SKILL.md"),
    read(path.join(workspace, WORKSPACE_FIXTURE)),
    shell(`cat ${foo}-other/SKILL.md ${foo}/../foo/../../x/SKILL.md`),
  ]);
  expect(found.map(({ index, type }) => [index, type])).toEqual([
    [0, "load"],
    [1, "load"],
    [2, "load"],
    [3, "file_read"],
    [4, "load"],
  ]);
});

test("a skill tool call names a skill without its plugin prefix, resolved when the subject has it", () => {
  const { events } = world();
  const calls: ToolCall[] = [
    { name: "Skill", kind: "skill", input: { skill: "kit:foo" } },
    { name: "skill", kind: "skill", input: { name: "bar" } },
    { name: "skill", kind: "skill", input: { id: "baz" } },
    { name: "skill", kind: "skill", input: null },
    { name: "Skill", kind: "skill", input: { skill: "" } },
  ];
  expect(
    events(calls).map(({ skill, resolved, via: how }) => [
      skill,
      resolved,
      how,
    ]),
  ).toEqual([
    ["foo", true, "skill_tool"],
    ["bar", false, "skill_tool"],
    ["baz", false, "skill_tool"],
  ]);
});

test("a call's own index is its position, and one call that names a file twice gives one event", () => {
  const { foo, events } = world();
  const file = path.join(foo, SKILL_MD);
  const found = events([
    { ...shell(`cat ${file} ${file}`), index: 7 },
    { name: "Read", kind: "read", input: {} },
    { name: "Edit", kind: "edit", input: { file_path: file } },
    { name: "Bash", kind: "shell", input: { command: 5 } },
  ]);
  expect(found.map(({ index }) => index)).toEqual([7]);
});

test("a skill copy that the adapter placed counts like the subject's own, and a subject with none counts nothing", () => {
  const { base, workspace, home } = world();
  const placed = path.join(home, ".claude/skills/foo");
  fs.mkdirSync(placed, { recursive: true });
  fs.writeFileSync(path.join(placed, SKILL_MD), "foo\n");
  const paths = { home, workspace, pathOf: () => null };
  const calls = [shell(`cat ${path.join(placed, SKILL_MD)}`)];
  const both = skillEvents(
    calls,
    { dir: null, skillDirs: {}, placed: { foo: placed } },
    paths,
  );
  expect(both.map(({ skill, via: how }) => [skill, how])).toEqual([
    ["foo", "shell_read"],
  ]);
  expect(skillEvents(calls, { dir: null, skillDirs: {} }, paths)).toEqual([]);
  expect(base).toBeTruthy();
});

test("the 0.0.1 rule counts any input that mentions skills/<name>/SKILL.md, in any case", () => {
  const loads = legacySkillLoads([
    shell("grep -r x skills/Alpha/skill.MD"),
    { name: "Skill", kind: "skill", input: { skill: "p:beta" } },
  ]);
  expect(loads).toEqual([
    { skill: "Alpha", index: 0 },
    { skill: "beta", index: 1 },
  ]);
});
