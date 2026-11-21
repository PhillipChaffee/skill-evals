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

function configured(t, config) {
	const box = sandbox(t);
	box.write("skill-evals.config.json", config);
	box.write("skills/greet/SKILL.md", "Say hello.\n");
	box.write("my-cases/hello/prompt.md", "say hello\n");
	box.write("my-cases/hello/case.json", { checks: [{ type: "output_contains", text: "no such text" }] });
	const outDir = path.join(box.root, "results");
	const score = (...flags) => {
		const result = box.cli(["score", "--out", outDir, ...flags]);
		const results = result.status === 2 ? null : JSON.parse(fs.readFileSync(path.join(outDir, "results.json"), "utf8"));
		return { result, results };
	};
	return { box, score };
}

test("config values become defaults and flags override them", (t) => {
	const config = { cases: "my-cases", reps: 2, model: "config-model", judgeModel: "config-judge", minScore: 0.5 };
	const { score } = configured(t, config);

	const fromConfig = score();
	assert.equal(fromConfig.result.status, 1, "the suite score 0 is under the configured bar");
	assert.deepEqual(
		fromConfig.results.records.map((record) => `${record.caseId} ${record.rep} ${JSON.parse(record.finalText).model}`),
		["hello 1 config-model", "hello 2 config-model"],
	);
	assert.equal(fromConfig.results.judge, "the harness under test, model config-judge");
	assert.match(fromConfig.result.stdout, /suite score 0\.00 does not reach --min-score 0\.50/);

	const fromFlags = score("--reps", "1", "--model", "flag-model", "--judge-model", "flag-judge", "--min-score", "0");
	assert.equal(fromFlags.result.status, 0, fromFlags.result.stderr);
	assert.deepEqual(
		fromFlags.results.records.map((record) => `${record.caseId} ${record.rep} ${JSON.parse(record.finalText).model}`),
		["hello 1 flag-model"],
	);
	assert.equal(fromFlags.results.judge, "the harness under test, model flag-judge");
});

test("an unknown config key is a usage error that names the key", (t) => {
	const { score } = configured(t, { cases: "my-cases", repetitions: 2 });
	const { result } = score();
	assert.equal(result.status, 2);
	assert.match(result.stderr, /skill-evals\.config\.json: unknown key "repetitions"/);

	const wrongType = configured(t, { cases: "my-cases", reps: "2" }).score();
	assert.equal(wrongType.result.status, 2);
	assert.match(wrongType.result.stderr, /"reps" must be a number/);
});

test("invalid JSON in the config is a usage error that names the file", (t) => {
	const { box, score } = configured(t, "{ cases: ");
	const { result } = score();
	assert.equal(result.status, 2);
	assert.ok(result.stderr.includes(path.join(box.root, "skill-evals.config.json")), result.stderr);
	assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
});

test("check asks the agent to use the subject's first skill, not a hardcoded one", (t) => {
	const box = sandbox(t);
	box.write("mine/zeta/SKILL.md", "z");
	box.write("mine/alpha/SKILL.md", "a");
	const probed = (subject) => {
		const outDir = path.join(box.root, `probe-${subject}`);
		const result = box.cli(["check", "--subject", subject, "--harness", "claude-code", "--out", outDir]);
		assert.equal(result.status, 0, result.stderr);
		return { ...JSON.parse(fs.readFileSync(path.join(outDir, "claude-code/hello/subject1.final.md"), "utf8")), stdout: result.stdout };
	};

	const withSkills = probed("mine");
	assert.equal(withSkills.prompt, 'Use the alpha skill on this sentence: "The cache is cold."');
	assert.match(withSkills.stdout, /^\| claude-code \| yes \| yes \| yes \| alpha \|/m);

	const none = probed("none");
	assert.equal(none.prompt, "Reply with the single word: pong");
	assert.match(none.stdout, /^\| claude-code \| yes \| yes \| nothing to load \| none \|/m);
});
