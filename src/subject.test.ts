import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { Project } from "./project.js";
import { UsageError } from "./scope.js";
import type { Subject } from "./subject.js";
import { resolveSubject } from "./subject.js";
import { gitRepo, sandbox } from "./testing/sandbox.js";

const projectAt = (root: string, isGitRepo = false): Project => ({
  root,
  isGitRepo,
  cwd: root,
});
const brief = ({ kind, dir, skills, commit }: Subject) => ({
  kind,
  dir,
  skills,
  commit,
});
const GREET = "greet/SKILL.md";

test("a folder of SKILL.md directories resolves to kind skills and lists them", () => {
  const box = sandbox();
  box.write("mine/zeta/SKILL.md", "z");
  box.write("mine/skills/alpha/SKILL.md", "a");
  box.write("mine/notes/README.md", "not a skill");
  const dir = path.join(box.root, "mine");

  const subject = resolveSubject("subject", "mine", projectAt(box.root));
  expect(brief(subject)).toEqual({
    kind: "skills",
    dir,
    skills: ["alpha", "zeta"],
    commit: null,
  });
  expect(subject.skillDirs).toEqual({
    alpha: path.join(dir, "skills/alpha"),
    zeta: path.join(dir, "zeta"),
  });
});

const MANIFESTS: [string, string, unknown][] = [
  ["claude", ".claude-plugin/plugin.json", {}],
  ["cursor", ".cursor-plugin/plugin.json", {}],
  ["codex", ".codex-plugin/plugin.json", {}],
  ["bare", "plugin.json", {}],
  ["opencode", ".opencode/plugins/main.js", "export default {}"],
  ["pi", "package.json", { name: "x", pi: { skills: ["./skills"] } }],
];

test.each(MANIFESTS)(
  "a folder with the %s plugin manifest resolves to kind plugin",
  (name, file, content) => {
    const box = sandbox();
    box.write(`${name}/${file}`, content);
    box.write(`${name}/skills/${GREET}`, "g");
    const dir = path.join(box.root, name);
    const subject = resolveSubject("subject", dir, projectAt(box.root));
    expect([subject.kind, subject.skills]).toEqual(["plugin", ["greet"]]);
  },
);

test("a folder with a package.json that is no Pi package resolves to kind skills", () => {
  const box = sandbox();
  for (const [name, manifest] of [
    ["node-package", { name: "x" }],
    ["broken-package", "{ not json"],
    ["odd-package", null],
  ] as const) {
    box.write(`${name}/package.json`, manifest);
    box.write(`${name}/${GREET}`, "g");
    const dir = path.join(box.root, name);
    expect(resolveSubject("subject", dir, projectAt(box.root)).kind).toBe(
      "skills",
    );
  }
});

test("a single-skill folder resolves to one skill named after the folder", () => {
  const box = sandbox();
  box.write(GREET, "g");
  const dir = path.join(box.root, "greet");
  const subject = resolveSubject("subject", dir, projectAt(box.root));
  expect(brief(subject)).toEqual({
    kind: "skills",
    dir,
    skills: ["greet"],
    commit: null,
  });
});

test("none resolves to no directory and no skills", () => {
  const box = sandbox();
  box.write(`none/${GREET}`, "a folder with this name needs a path: ./none");
  const none = resolveSubject("a", "none", projectAt(box.root));
  expect(brief(none)).toEqual({
    kind: "none",
    dir: null,
    skills: [],
    commit: null,
  });
  none.dispose();
  expect(resolveSubject("a", "./none", projectAt(box.root)).kind).toBe(
    "skills",
  );
});

test("an empty folder is a usage error that names the folder", async () => {
  const box = sandbox();
  fs.mkdirSync(path.join(box.root, "empty"));
  box.write("evals/cases/hello/prompt.md", "say hello\n");
  box.write("evals/cases/hello/case.json", {
    checks: [{ type: "output_contains", text: "hello" }],
  });
  expect(() =>
    resolveSubject("subject", "./empty", projectAt(box.root)),
  ).toThrow(UsageError);

  const outDir = path.join(box.root, "results");
  const result = await box.cli([
    "score",
    "--subject",
    "./empty",
    "--out",
    outDir,
  ]);
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/no skills found in \.\/empty/);
  expect(fs.existsSync(outDir), "nothing ran").toBe(false);
});

test("two skills of one name in a folder are a usage error", () => {
  const box = sandbox();
  box.write(`mine/${GREET}`, "one");
  box.write(`mine/skills/${GREET}`, "two");
  expect(() => resolveSubject("subject", "mine", projectAt(box.root))).toThrow(
    /two skills named "greet"/,
  );
});

/**
 * Makes a git repository that is itself the skill `greet`, with two commits and an uncommitted change.
 * @returns The repository, a `git` bound to it, its project, and a count of its worktrees.
 */
function skillRepo() {
  const box = sandbox();
  const repo = path.join(box.root, "greet");
  fs.mkdirSync(repo);
  const git = gitRepo(repo);
  for (const version of ["one", "two"]) {
    fs.writeFileSync(path.join(repo, "SKILL.md"), version);
    git("add", ".");
    git("commit", "-q", "-m", version);
  }
  fs.writeFileSync(path.join(repo, "SKILL.md"), "uncommitted");
  const worktrees = () =>
    git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length;
  return { repo, git, project: projectAt(repo, true), worktrees };
}

// What a run copies: the export, which for a git ref holds the committed files.
const skillText = (subject: Subject) =>
  fs.readFileSync(
    path.join(
      subject.exported ?? "",
      path.relative(subject.dir ?? "", subject.skillDirs["greet"] ?? ""),
      "SKILL.md",
    ),
    "utf8",
  );

test("a git ref is exported with the files of that commit, and dispose removes the export every time", () => {
  const { git, project, worktrees } = skillRepo();

  const old = resolveSubject("a", "trunk~1", project);
  expect(skillText(old)).toBe("one");
  expect(old.commit).toBe(git("rev-parse", "trunk~1"));
  expect(old.skills, "named after the project folder").toEqual(["greet"]);
  expect(old.dir, "the project, for the report").toBe(project.root);
  expect(path.basename(old.exported ?? "")).toMatch(/^kit-/);
  expect(worktrees(), "no worktree").toBe(1);
  old.dispose();
  old.dispose();
  expect(fs.existsSync(old.exported ?? "")).toBe(false);
});

test("a directory subject is exported with its uncommitted changes, and its source is never removed", () => {
  const { repo, project } = skillRepo();
  const live = resolveSubject("b", repo, project);
  expect(skillText(live)).toBe("uncommitted");
  expect(live.commit).toBeNull();
  live.dispose();
  expect(fs.existsSync(repo)).toBe(true);
});

test("a ref that is no subject is a usage error and leaves no export behind", () => {
  const { project, worktrees } = skillRepo();
  expect(() => resolveSubject("a", "no-such-ref", project)).toThrow(UsageError);
  expect(() => resolveSubject("a", "trunk~2", project)).toThrow(
    /no skills found in trunk~2/,
  );
  expect(worktrees()).toBe(1);
});
