import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { findProject } from "../src/project.mjs";
import { gitRepo, sandbox } from "./helpers.mjs";

test("the project root is the git top level of a nested working directory", (t) => {
	const box = sandbox(t);
	gitRepo(box.root);
	const nested = path.dirname(box.write("packages/app/notes.txt", "x"));
	assert.deepEqual(findProject(nested), { root: box.root, isGitRepo: true, cwd: nested });
});

test("outside a git repo the project root is the working directory", (t) => {
	const box = sandbox(t);
	assert.deepEqual(findProject(box.root), { root: box.root, isGitRepo: false, cwd: box.root });
});

test("run --a main outside a git repo exits 2 and names the folder", (t) => {
	const box = sandbox(t);
	box.write("evals/cases/hello/prompt.md", "say hello\n");
	box.write("evals/cases/hello/case.json", { checks: [{ type: "output_contains", text: "hello" }] });

	const result = box.cli(["run", "--a", "main"]);
	assert.equal(result.status, 2);
	assert.ok(result.stderr.includes(box.root), result.stderr);
	assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
});

test("score with no flags uses <root>/evals/cases and the working tree", (t) => {
	const box = sandbox(t);
	gitRepo(box.root);
	box.write("evals/cases/hello/prompt.md", "say hello\n");
	box.write("evals/cases/hello/case.json", { checks: [{ type: "file_exists", path: "out/summary.txt" }] });
	box.write("skills/greet/SKILL.md", "Say hello.\n");
	const nested = path.dirname(box.write("packages/app/notes.txt", "x"));

	const result = box.cli(["score", "--reps", "1"], {}, nested);
	assert.equal(result.status, 0, result.stderr);
	const outDir = result.stdout.match(/^- Output: (.+)$/m)[1];
	t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
	const { subjects, records } = JSON.parse(fs.readFileSync(path.join(outDir, "results.json"), "utf8"));
	assert.deepEqual([subjects[0].dir, subjects[0].skills], [box.root, ["greet"]]);
	assert.deepEqual(
		records.map((record) => `${record.caseId} ${record.score}`),
		["hello 1"],
	);
	assert.match(path.basename(outDir), /^runs-/);
});
