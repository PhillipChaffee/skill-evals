import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { failedBars, scoreSuites, weightedMean } from "../src/score.mjs";
import { fakeHarness, sandbox } from "./helpers.mjs";

function plugin(box, name, behavior) {
	box.write(`${name}/.claude-plugin/plugin.json`, { name });
	box.write(`${name}/behavior.json`, { name, ...behavior });
	return path.join(box.root, name);
}

function skillsFolder(box, name, skills) {
	for (const [skill, text] of Object.entries(skills)) box.write(`${name}/${skill}/SKILL.md`, text);
	return path.join(box.root, name);
}

const CHECKS = [
	{ type: "skill_loaded", skill: "bro" },
	{ type: "skill_not_loaded", skill: "bro" },
	{ type: "output_matches", pattern: '"seed":"planted"' },
	{ type: "output_lacks", pattern: '"leaks":0' },
	{ type: "file_exists", path: "out/summary.txt" },
	{ type: "file_exists", path: "out/missing.txt" },
	{ type: "file_matches", path: "out/summary.txt", pattern: "^summary by plugin-beta$", flags: "m" },
];

function plantCase(box, checks = CHECKS) {
	box.write("cases/restate/prompt.md", "say it in plain words\n");
	box.write("cases/restate/case.json", { checks });
	box.write("cases/restate/workspace/notes.txt", "planted\n");
	return path.join(box.root, "cases");
}

test("run reports the difference between two plugin directories and leaves no temp state behind", (t) => {
	const box = sandbox(t);
	const pluginA = plugin(box, "plugin-alpha", { costUsd: 0.01 });
	const pluginB = plugin(box, "plugin-beta", { costUsd: 0.03, skill: "bro" });
	const outDir = path.join(box.root, "results");

	const result = box.cli(["run", "--a", pluginA, "--b", pluginB, "--cases", plantCase(box), "--reps", "2", "--out", outDir]);
	assert.equal(result.status, 0, result.stderr);

	const { records } = JSON.parse(fs.readFileSync(path.join(outDir, "results.json"), "utf8"));
	assert.deepEqual(
		records.map((record) => `${record.harness} ${record.caseId} ${record.subject}${record.rep}`),
		["a1", "b1", "a2", "b2"].map((run) => `claude-code restate ${run}`),
	);
	const scores = (label) => records.find((record) => record.subject === label).checks.map((check) => check.score);
	assert.deepEqual(scores("a"), [0, 1, 1, 0, 1, 0, 0]);
	assert.deepEqual(scores("b"), [1, 0, 1, 0, 1, 0, 1]);
	for (const record of records) {
		assert.equal(record.ok, true);
		assert.equal(record.subjectLoaded, true);
		assert.deepEqual(record.skillsLoaded, record.subject === "b" ? ["bro"] : []);
		assert.deepEqual(record.tokens, { input: 1000, output: 50 });
		const seen = JSON.parse(record.finalText);
		assert.equal(seen.prompt, "say it in plain words");
		assert.match(path.basename(seen.home), /^home-/);
		assert.match(path.basename(seen.cwd), /^proj-/);
		assert.equal(fs.existsSync(seen.home), false, "throwaway home must be removed");
		assert.equal(fs.existsSync(seen.cwd), false, "workspace must be removed");
	}

	const row = result.stdout.split("\n").find((line) => line.startsWith("| restate |"));
	assert.match(row, /`skill_loaded bro` A 0\/2, B 2\/2/);
	assert.match(row, /`file_matches out\/summary\.txt \/\^summary by plugin-beta\$\/m` A 0\/2, B 2\/2/);
	assert.match(row, /\$0\.0100 \/ \$0\.0300 \(\+\$0\.0200\)/);
	assert.match(row, /1000 \/ 1000 \(\+0\)/);
	assert.match(result.stdout, /^- Harness: claude-code \(default/m);

	const runDir = path.join(outDir, "claude-code/restate");
	assert.equal(fs.readFileSync(path.join(runDir, "b2.final.md"), "utf8"), records[3].finalText);
	assert.match(fs.readFileSync(path.join(runDir, "a1.stream.jsonl"), "utf8"), /"type":"result"/);
});

test("run does not count a run whose harness loaded some other plugin, and exits non-zero", (t) => {
	const box = sandbox(t);
	const pluginA = plugin(box, "plugin-alpha", { costUsd: 0.01 });
	const ghost = plugin(box, "plugin-ghost", { costUsd: 0.01, skill: "bro", ghost: true });
	const outDir = path.join(box.root, "results");

	const result = box.cli(["run", "--a", pluginA, "--b", ghost, "--cases", plantCase(box), "--reps", "1", "--out", outDir]);
	assert.equal(result.status, 1, result.stderr);

	const { records } = JSON.parse(fs.readFileSync(path.join(outDir, "results.json"), "utf8"));
	assert.deepEqual(
		records.map((record) => record.subjectLoaded),
		[true, false],
	);
	const row = result.stdout.split("\n").find((line) => line.startsWith("| restate |"));
	assert.match(row, /`skill_loaded bro` A 0\/1, B n\/a/);
	assert.match(result.stdout, /^- B `restate` rep 1: /m);
});

test("run rejects a bad case file or command line before it starts any harness", (t) => {
	const box = sandbox(t);
	const pluginA = plugin(box, "plugin-alpha", { costUsd: 0.01 });
	const outDir = path.join(box.root, "results");
	const run = (...extra) => box.cli(["run", "--a", pluginA, "--b", pluginA, "--out", outDir, ...extra]);
	const cases = plantCase(box, [{ type: "smells_right", skill: "bro" }]);

	const unknownCheck = run("--cases", cases);
	assert.equal(unknownCheck.status, 2);
	assert.match(unknownCheck.stderr, /unknown check type "smells_right"/);

	box.write("cases/restate/case.json", { checks: [{ type: "file_exists", path: "../outside.txt" }] });
	assert.equal(run("--cases", cases).status, 2);
	box.write("cases/restate/case.json", { checks: [{ type: "output_matches", pattern: "(" }] });
	assert.equal(run("--cases", cases).status, 2);

	const badCase = (caseFile, message) => {
		box.write("cases/restate/case.json", caseFile);
		const result = run("--cases", cases);
		assert.equal(result.status, 2, JSON.stringify(caseFile));
		assert.match(result.stderr, message);
	};
	const fine = { type: "file_exists", path: "notes.txt" };
	badCase({ checks: [] }, /non-empty/);
	badCase({ checks: [{ ...fine, weight: 0 }] }, /weight must be a positive number/);
	badCase({ checks: [fine], weight: -1 }, /weight must be a positive number/);
	badCase({ checks: [fine], minScore: 1.5 }, /minScore must be a number from 0 to 1/);
	badCase({ checks: [{ type: "tool_called", inputMatches: "push" }] }, /at least one of "kind", "name"/);
	badCase({ checks: [{ type: "tool_called", kind: "terminal" }] }, /unknown tool kind "terminal"/);
	badCase({ checks: [{ type: "tool_not_called", name: "(" }] }, /Invalid regular expression/);
	badCase({ checks: [{ type: "output_contains" }] }, /needs a string "text"/);
	badCase({ checks: [{ type: "judge" }] }, /needs a string "rubric"/);

	box.write("cases/restate/case.json", { checks: [fine] });
	assert.equal(run("--cases", cases, "--harness", "emacs").status, 2);
	assert.equal(run("--cases", cases, "--judge-harness", "emacs").status, 2);
	assert.equal(run("--cases", cases, "--min-score", "1.2").status, 2);
	assert.equal(run("--cases", cases, "--case", "no-such-*").status, 2);
	assert.equal(run("--cases", cases, "--reps", "0").status, 2);
	assert.equal(run("--cases", cases, "--b", "no-such-ref-or-dir").status, 2);
	assert.equal(box.cli(["frobnicate"]).status, 2);

	assert.equal(fs.existsSync(path.join(outDir, "results.json")), false);
	assert.equal(fs.existsSync(path.join(outDir, "claude-code")), false);
});

const WEIGHTED = [
	{ type: "skill_loaded", skill: "bro", weight: 3 },
	{ type: "output_contains", text: '"seed":"planted"' },
	{ type: "tool_called", kind: "skill", inputMatches: "plugin:bro" },
	{ type: "tool_not_called", name: "^Bash$" },
];

test("scores are weighted means, and a suite or case score under its bar fails the command", (t) => {
	const box = sandbox(t);
	const plain = plugin(box, "plugin-alpha", { costUsd: 0.01 });
	const skilled = plugin(box, "plugin-beta", { costUsd: 0.01, skill: "bro" });
	const cases = plantCase(box, WEIGHTED);
	box.write("cases/steady/prompt.md", "anything\n");
	box.write("cases/steady/case.json", { checks: [{ type: "output_not_contains", text: "no such text" }], weight: 2 });
	const outDir = path.join(box.root, "results");
	const run = (a, b, ...extra) => box.cli(["run", "--a", a, "--b", b, "--cases", cases, "--reps", "1", "--out", outDir, ...extra]);
	const results = () => JSON.parse(fs.readFileSync(path.join(outDir, "results.json"), "utf8"));

	const better = run(plain, skilled, "--min-score", "0.9");
	assert.equal(better.status, 0, better.stderr);
	// restate: A passes 2 of weights 3+1+1+1, B passes all. Suite: restate weight 1, steady weight 2.
	assert.deepEqual(
		results().records.map((record) => `${record.caseId} ${record.subject} ${record.score.toFixed(3)}`),
		["restate a 0.333", "restate b 1.000", "steady a 1.000", "steady b 1.000"],
	);
	assert.deepEqual(results().suites, [
		{
			harness: "claude-code",
			cases: [
				{ id: "restate", weight: 1, scores: { a: 1 / 3, b: 1 } },
				{ id: "steady", weight: 2, scores: { a: 1, b: 1 } },
			],
			suite: { a: (1 / 3 + 2) / 3, b: 1 },
		},
	]);
	assert.match(better.stdout, /^\| restate \| 0\.33 \/ 1\.00 \(\+0\.67\) \| `skill_loaded bro \(weight 3\)` A 0\/1, B 1\/1<br>/m);
	assert.match(better.stdout, /^Suite score: 0\.78 \/ 1\.00 \(\+0\.22\)$/m);
	assert.doesNotMatch(better.stdout, /pass bar/);

	const worse = run(skilled, plain, "--min-score", "0.9");
	assert.equal(worse.status, 1);
	assert.match(worse.stdout, /^- claude-code: suite score 0\.78 does not reach --min-score 0\.90$/m);
	assert.deepEqual(results().belowBar.length, 1);
	assert.equal(run(skilled, plain, "--min-score", "0.7").status, 0);

	box.write("cases/restate/case.json", { checks: WEIGHTED, minScore: 0.5 });
	const underCaseBar = run(skilled, plain);
	assert.equal(underCaseBar.status, 1);
	assert.match(underCaseBar.stdout, /^- claude-code: case `restate` score 0\.33 does not reach its minScore 0\.50$/m);
	assert.equal(run(plain, skilled).status, 0, "the bars apply to B, the subject under test");
});

test("a case score is the mean over the reps of the valid runs, and a suite with an unscored case has no score", () => {
	const run = (caseId, subject, score) => ({ harness: "h", caseId, subject, score });
	const cases = [
		{ id: "one", weight: 1 },
		{ id: "two", weight: 3, minScore: 0.8 },
	];
	const records = [
		...[1, 0.5, null].map((score) => run("one", "a", score)),
		...[0.8, 0.8, 0.8].map((score) => run("two", "a", score)),
		...[0.25, 0.75].map((score) => run("one", "b", score)),
		run("two", "b", null),
		{ ...run("one", "b", 1), harness: "other" },
	];
	const [suite, ...rest] = scoreSuites(["h"], cases, records, ["a", "b"]);
	assert.equal(rest.length, 0);
	assert.deepEqual(
		suite.cases.map((scored) => scored.scores),
		[
			{ a: 0.75, b: 0.5 },
			{ a: weightedMean([0.8, 0.8, 0.8].map((score) => ({ score, weight: 1 }))), b: null },
		],
	);
	assert.ok(Math.abs(suite.suite.a - (0.75 + 3 * 0.8) / 4) < 1e-12);
	assert.equal(suite.suite.b, null);

	assert.deepEqual(failedBars([suite], "a", 0.7875), [], "a mean that equals its bar reaches it");
	assert.deepEqual(failedBars([suite], "a", 0.79), ["h: suite score 0.79 does not reach --min-score 0.79"]);
	assert.deepEqual(failedBars([suite], "b", 0.1), [
		"h: suite score n/a does not reach --min-score 0.10",
		"h: case `two` score n/a does not reach its minScore 0.80",
	]);
	assert.deepEqual(failedBars([suite], "b", undefined).length, 1);
});

test("score runs the suite on one subject and applies the pass bar to it", (t) => {
	const box = sandbox(t);
	const plain = plugin(box, "plugin-alpha", { costUsd: 0.01 });
	const skilled = plugin(box, "plugin-beta", { costUsd: 0.03, skill: "bro" });
	const cases = plantCase(box, WEIGHTED);
	const outDir = path.join(box.root, "results");
	const score = (dir, ...extra) => box.cli(["score", "--subject", dir, "--cases", cases, "--reps", "2", "--out", outDir, ...extra]);

	const good = score(skilled, "--min-score", "1");
	assert.equal(good.status, 0, good.stderr);
	const { records, subjects } = JSON.parse(fs.readFileSync(path.join(outDir, "results.json"), "utf8"));
	assert.deepEqual(
		records.map((record) => `${record.subject}${record.rep} ${record.score}`),
		["subject1 1", "subject2 1"],
	);
	assert.deepEqual(
		subjects.map((subject) => `${subject.kind} ${subject.dir}`),
		[`plugin ${skilled}`],
	);
	assert.match(good.stdout, /^# Skill scores$/m);
	assert.match(good.stdout, /^\| restate \| 1\.00 \| `skill_loaded bro \(weight 3\)` 2\/2<br>.*\| \$0\.0300 \|$/m);
	assert.match(good.stdout, /^Suite score: 1\.00$/m);
	assert.equal(fs.existsSync(path.join(outDir, "claude-code/restate/subject2.final.md")), true);

	const bad = score(plain, "--min-score", "0.5");
	assert.equal(bad.status, 1);
	assert.match(bad.stdout, /suite score 0\.33 does not reach --min-score 0\.50/);
	assert.equal(box.cli(["score", "--a", plain, "--cases", cases]).status, 2, "score takes one subject");
});

const RUBRIC = "Says the word fixed and nothing about weather.";

function judgedRun(t, replies, ...extra) {
	const box = sandbox(t);
	const pluginA = plugin(box, "plugin-alpha", { costUsd: 0.01, answer: "It is fixed now." });
	const pluginB = plugin(box, "plugin-beta", { costUsd: 0.01, answer: "It is fixed now." });
	const cases = plantCase(box, [
		{ type: "judge", rubric: RUBRIC, weight: 3 },
		{ type: "output_contains", text: "broken" },
	]);
	box.write("judge/replies.json", replies);
	const outDir = path.join(box.root, "results");
	const result = box.cli(["run", "--a", pluginA, "--b", pluginB, "--cases", cases, "--out", outDir, ...extra], {
		FAKE_JUDGE_DIR: path.join(box.root, "judge"),
		SKILL_EVALS_BIN_CODEX: fakeHarness,
	});
	const asked = fs
		.readFileSync(path.join(box.root, "judge/prompts.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const { records } = JSON.parse(fs.readFileSync(path.join(outDir, "results.json"), "utf8"));
	return { box, result, asked, records };
}

test("a judged check takes its score from a model that sees the task, the answer, and the rubric, and nothing else", (t) => {
	const replies = [
		'{"score": 0.5, "reason": "half of it"}',
		"I would say it is quite good.",
		'Here you go:\n```json\n{"score": 1, "reason": "all of it {really}"}\n```',
		'{"score": 1.5, "reason": "more than all"}',
		'{"score": "high"}',
		'{"score": 0, "reason": "none of it"}',
	];
	const { box, result, asked, records } = judgedRun(t, replies, "--reps", "2", "--model", "run-model");
	assert.equal(result.status, 1, "one run has no score");

	const judged = records.map((record) => record.checks[0]);
	assert.deepEqual(
		judged.map((check) => check.score),
		[0.5, 1, null, 0],
	);
	assert.deepEqual(
		judged.map((check) => check.reason),
		[
			"half of it",
			"all of it {really}",
			'the judge gave no usable score: the score must be a number from 0 to 1, got "high"',
			"none of it",
		],
	);
	assert.deepEqual(
		records.map((record) => record.score),
		[0.375, 0.75, null, 0],
	);
	assert.deepEqual(
		records.map((record) => record.judge.calls),
		[1, 2, 2, 1],
	);
	assert.equal(records[1].judge.costUsd, 0.004);
	assert.deepEqual(records[1].judge.tokens, { input: 2000, output: 100 });
	assert.equal(records[1].costUsd, 0.01, "the judge's cost stays out of the run's own");

	assert.equal(asked.length, replies.length);
	assert.equal(new Set(asked.map((call) => call.prompt)).size, 1, "A and B get the same prompt, byte for byte");
	const [{ prompt, model }] = asked;
	for (const part of ["say it in plain words", "It is fixed now.", RUBRIC]) assert.ok(prompt.includes(part), part);
	for (const secret of [box.root, "plugin-alpha", "plugin-beta", "claude-code", "run-model"]) assert.ok(!prompt.includes(secret), secret);
	assert.equal(model, "run-model", "the judge model defaults to --model");
	assert.equal(asked[0].pluginDir, null, "the judge runs with nothing loaded");

	const row = result.stdout.split("\n").find((line) => line.startsWith("| restate |"));
	assert.match(
		row,
		/^\| restate \| 0\.38 \/ 0\.38 \(\+0\.00\) \| `judge "Says the word fixed[^`]*\(weight 3\)` A 0\.50, B 0\.50<br>`output_contains "broken"` A 0\/1, B 0\/2 \|/,
	);
	assert.match(result.stdout, /^- Judge: the harness under test, model run-model$/m);
	assert.match(result.stdout, /^Judge, in total and not counted in the table: 6 calls, .*cost \$0\.0120$/m);
	assert.match(result.stdout, /^- A `restate` rep 2: a judged check has no score: the judge gave no usable score/m);
});

test("the judge runs on the harness and the model that the judge flags name", (t) => {
	const flags = ["--reps", "1", "--model", "run-model", "--judge-model", "judge-model"];
	const sameHarness = judgedRun(t, ['{"score": 1, "reason": "yes"}', '{"score": 1, "reason": "yes"}'], ...flags);
	assert.equal(sameHarness.result.status, 0, sameHarness.result.stderr);
	assert.deepEqual(
		sameHarness.asked.map((call) => call.model),
		["judge-model", "judge-model"],
	);

	// The fake speaks Claude Code's stream format, so a judge behind the Codex adapter yields no answer.
	const otherHarness = judgedRun(t, Array(4).fill('{"score": 1, "reason": "yes"}'), ...flags, "--judge-harness", "codex");
	assert.equal(otherHarness.result.status, 1);
	assert.equal(otherHarness.asked.length, 4, "two runs, each asked twice");
	assert.match(otherHarness.records[0].checks[0].reason, /no turn\.completed event/);
	assert.match(otherHarness.result.stdout, /^- Judge: codex, model judge-model$/m);
});

test("check shows, for each harness, that it is missing or what its adapter delivered for the subject", (t) => {
	const box = sandbox(t);
	box.write("skills/greet/SKILL.md", "Say hello.\n");
	const cells = (stdout, id) =>
		stdout
			.split("\n")
			.find((line) => line.startsWith(`| ${id} |`))
			.split("|")
			.map((text) => text.trim());

	const result = box.cli(["check", "--out", path.join(box.root, "probe")]);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(cells(result.stdout, "claude-code").slice(2, 7), ["yes", "yes", "yes", "greet", "finalText, toolCalls, tokens"]);
	assert.match(cells(result.stdout, "pi")[2], /^no /);

	// The fake speaks one harness's stream format, so behind another adapter the run must be reported as failed.
	const broken = box.cli(["check", "--harness", "codex", "--out", path.join(box.root, "probe")], { SKILL_EVALS_BIN_CODEX: fakeHarness });
	assert.equal(broken.status, 1);
	assert.match(cells(broken.stdout, "codex")[3], /^NO: /);
});

test("check reports a harness that fails to log in as ran: no and continues", (t) => {
	const box = sandbox(t);
	box.write("skills/greet/SKILL.md", "Say hello.\n");

	const fixture = (name) => path.join(import.meta.dirname, "fixtures", name);
	const env = { SKILL_EVALS_BIN_PI: fixture("logged-out-harness.mjs"), SKILL_EVALS_BIN_CODEX: fixture("garbled-harness.mjs") };
	const result = box.cli(["check", "--out", path.join(box.root, "probe")], env);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stdout, /^\| pi \| yes \| NO: exit 1: Error: Authentication required\. Please run 'agent login' first\. \|/m);
	assert.match(result.stdout, /^\| claude-code \| yes \| yes \| yes \| greet \|/m);
	assert.match(result.stdout, /^\| codex \| yes \| NO: the codex adapter could not read the stream: /m);
});

test("a prompt that starts with a dash reaches the agent as the prompt", (t) => {
	const box = sandbox(t);
	box.write("cases/dashed/prompt.md", "--help me\n");
	box.write("cases/dashed/case.json", { checks: [{ type: "output_contains", text: '"prompt":"--help me"' }] });
	const outDir = path.join(box.root, "results");

	const result = box.cli(["score", "--subject", "none", "--cases", path.join(box.root, "cases"), "--reps", "1", "--out", outDir]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^Suite score: 1\.00$/m);
});

const GREET_CASE = [{ type: "skill_loaded", skill: "greet" }];

function greetRun(t, args, env) {
	const box = sandbox(t);
	const mine = skillsFolder(box, "mine", { greet: "the copy under test\n" });
	// The sandbox root is the real home of the command, so this is a globally installed skill.
	box.write(".claude/skills/greet/SKILL.md", "the global copy\n");
	box.write("cases/hello/prompt.md", "use greet to say hello\n");
	box.write("cases/hello/case.json", { checks: GREET_CASE });
	const outDir = path.join(box.root, "results");
	const result = box.cli([...args(mine), "--cases", path.join(box.root, "cases"), "--reps", "1", "--out", outDir], env);
	const { records, subjects } = JSON.parse(fs.readFileSync(path.join(outDir, "results.json"), "utf8"));
	return { box, result, records, subjects };
}

test("a globally installed skill of the same name does not load", (t) => {
	const { box, result, records } = greetRun(t, (mine) => ["score", "--subject", mine]);
	assert.equal(result.status, 0, result.stderr);
	const seen = JSON.parse(records[0].finalText);
	assert.deepEqual(seen.skills, { greet: "the copy under test\n" });
	assert.ok(!seen.home.startsWith(box.root));
	assert.equal(records[0].subjectLoaded, true);
});

test("run --a none --b <skills dir> reports the no-skills baseline as A", (t) => {
	const { result, records, subjects } = greetRun(t, (mine) => ["run", "--a", "none", "--b", mine]);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(
		subjects.map(({ label, kind, skills }) => ({ label, kind, skills })),
		[
			{ label: "a", kind: "none", skills: [] },
			{ label: "b", kind: "skills", skills: ["greet"] },
		],
	);
	assert.deepEqual(
		records.map((record) => [record.subject, record.skillsLoaded, JSON.parse(record.finalText).skills, record.score]),
		[
			["a", [], {}, 0],
			["b", ["greet"], { greet: "the copy under test\n" }, 1],
		],
	);
	assert.match(result.stdout, /^- A: no skills$/m);
	assert.match(result.stdout, /`skill_loaded greet` A 0\/1, B 1\/1/);
	assert.match(result.stdout, /^Suite score: 0\.00 \/ 1\.00 \(\+1\.00\)$/m);
});

test("a run whose harness lists none of the subject's skills is invalid", (t) => {
	const { result, records } = greetRun(t, (mine) => ["score", "--subject", mine], { FAKE_HIDE_SKILLS: "1" });
	assert.equal(result.status, 1);
	assert.equal(records[0].subjectLoaded, false);
	assert.equal(records[0].score, null);
	assert.match(result.stdout, /^- SUBJECT `hello` rep 1: the harness did not load the subject/m);
});
