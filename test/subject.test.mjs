import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { UsageError } from "../src/scope.mjs";
import { resolveSubject } from "../src/subject.mjs";
import { gitRepo, sandbox } from "./helpers.mjs";

const projectAt = (root, isGitRepo = false) => ({ root, isGitRepo, cwd: root });
const brief = ({ kind, dir, skills, commit }) => ({ kind, dir, skills, commit });

test("a folder of SKILL.md directories resolves to kind skills and lists them", (t) => {
	const box = sandbox(t);
	box.write("mine/zeta/SKILL.md", "z");
	box.write("mine/skills/alpha/SKILL.md", "a");
	box.write("mine/notes/README.md", "not a skill");
	const dir = path.join(box.root, "mine");

	const subject = resolveSubject("subject", "mine", projectAt(box.root));
	assert.deepEqual(brief(subject), { kind: "skills", dir, skills: ["alpha", "zeta"], commit: null });
	assert.deepEqual(subject.skillDirs, { alpha: path.join(dir, "skills/alpha"), zeta: path.join(dir, "zeta") });
});

test("a folder with a plugin manifest resolves to kind plugin", (t) => {
	const box = sandbox(t);
	const manifests = {
		claude: [".claude-plugin/plugin.json", {}],
		cursor: [".cursor-plugin/plugin.json", {}],
		codex: [".codex-plugin/plugin.json", {}],
		bare: ["plugin.json", {}],
		opencode: [".opencode/plugins/main.js", "export default {}"],
		pi: ["package.json", { name: "x", pi: { skills: ["./skills"] } }],
	};
	for (const [name, [file, content]] of Object.entries(manifests)) {
		box.write(`${name}/${file}`, content);
		box.write(`${name}/skills/greet/SKILL.md`, "g");
		const subject = resolveSubject("subject", path.join(box.root, name), projectAt(box.root));
		assert.deepEqual([subject.kind, subject.skills], ["plugin", ["greet"]], name);
	}
	box.write("node-package/package.json", { name: "x" });
	box.write("node-package/greet/SKILL.md", "g");
	assert.equal(resolveSubject("subject", path.join(box.root, "node-package"), projectAt(box.root)).kind, "skills");
});

test("a single-skill folder resolves to one skill named after the folder", (t) => {
	const box = sandbox(t);
	box.write("greet/SKILL.md", "g");
	const subject = resolveSubject("subject", path.join(box.root, "greet"), projectAt(box.root));
	assert.deepEqual(brief(subject), { kind: "skills", dir: path.join(box.root, "greet"), skills: ["greet"], commit: null });
});

test("none resolves to no directory and no skills", (t) => {
	const box = sandbox(t);
	box.write("none/greet/SKILL.md", "a folder with this name needs a path: ./none");
	assert.deepEqual(brief(resolveSubject("a", "none", projectAt(box.root))), { kind: "none", dir: null, skills: [], commit: null });
	assert.equal(resolveSubject("a", "./none", projectAt(box.root)).kind, "skills");
});

test("an empty folder is a usage error that names the folder", (t) => {
	const box = sandbox(t);
	fs.mkdirSync(path.join(box.root, "empty"));
	box.write("evals/cases/hello/prompt.md", "say hello\n");
	box.write("evals/cases/hello/case.json", { checks: [{ type: "output_contains", text: "hello" }] });
	assert.throws(() => resolveSubject("subject", "./empty", projectAt(box.root)), UsageError);

	const result = box.cli(["score", "--subject", "./empty", "--out", path.join(box.root, "results")]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /no skills found in \.\/empty/);
	assert.equal(fs.existsSync(path.join(box.root, "results")), false, "nothing ran");
});

test("two skills of one name in a folder are a usage error", (t) => {
	const box = sandbox(t);
	box.write("mine/greet/SKILL.md", "one");
	box.write("mine/skills/greet/SKILL.md", "two");
	assert.throws(() => resolveSubject("subject", "mine", projectAt(box.root)), /two skills named "greet"/);
});

test("a git ref resolves to a detached worktree of that commit, and dispose removes it every time", (t) => {
	const box = sandbox(t);
	const repo = path.join(box.root, "greet");
	fs.mkdirSync(repo);
	const git = gitRepo(repo);
	for (const version of ["one", "two"]) {
		fs.writeFileSync(path.join(repo, "SKILL.md"), version);
		git("add", ".");
		git("commit", "-q", "-m", version);
	}
	fs.writeFileSync(path.join(repo, "SKILL.md"), "uncommitted");
	const project = projectAt(repo, true);
	const worktrees = () => git("worktree", "list", "--porcelain").match(/^worktree /gm).length;
	const skillText = (subject) => fs.readFileSync(path.join(subject.skillDirs.greet, "SKILL.md"), "utf8");

	const old = resolveSubject("a", "trunk~1", project);
	assert.equal(skillText(old), "one");
	assert.equal(old.commit, git("rev-parse", "trunk~1"));
	assert.deepEqual(old.skills, ["greet"], "a ref's own skill is named after the project folder, not the worktree");
	assert.match(path.basename(old.dir), /^kit-/);
	assert.equal(worktrees(), 2);
	old.dispose();
	old.dispose();
	assert.equal(fs.existsSync(old.dir), false);
	assert.equal(worktrees(), 1);

	const live = resolveSubject("b", repo, project);
	assert.equal(skillText(live), "uncommitted");
	assert.equal(live.commit, null);
	live.dispose();
	assert.equal(fs.existsSync(repo), true, "a directory subject is never removed");

	assert.throws(() => resolveSubject("a", "no-such-ref", project), UsageError);
	assert.throws(() => resolveSubject("a", "trunk~2", project), /no skills found in trunk~2/);
	assert.equal(worktrees(), 1, "a ref that is no subject leaves no worktree behind");
});
