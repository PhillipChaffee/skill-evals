import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HARNESSES, evaluate, loadCases } from "skill-evals";
import { main } from "../src/cli.mjs";
import { fakeHarness, sandbox } from "./helpers.mjs";

test("evaluate returns suite scores for one subject without printing or exiting", async (t) => {
	const box = sandbox(t);
	box.write("mine/greet/SKILL.md", "Say hello.\n");
	box.write("evals/cases/hello/prompt.md", "use greet to say hello\n");
	box.write("evals/cases/hello/case.json", { checks: [{ type: "skill_loaded", skill: "greet" }, { type: "output_contains", text: "no such text" }] });
	// The harness is found through the environment of this process, as it is for the CLI.
	const env = { PATH: path.join(box.root, "bin"), HOME: box.root, SKILL_EVALS_BIN_CLAUDE_CODE: fakeHarness };
	const before = { ...process.env };
	Object.assign(process.env, env);
	t.after(() => {
		for (const key of Object.keys(env)) delete process.env[key];
		Object.assign(process.env, before);
	});
	const printed = ["log", "error"].map((method) => t.mock.method(console, method, () => {}));
	const seen = [];

	const evaluation = await evaluate({
		cwd: box.root,
		subjects: ["mine"],
		reps: 2,
		minScore: 0.9,
		outDir: "results",
		onRun: (record) => seen.push(`${record.subject}${record.rep}`),
	});

	assert.deepEqual(evaluation.suites, [
		{ harness: "claude-code", cases: [{ id: "hello", weight: 1, minScore: undefined, scores: { subject: 0.5 } }], suite: { subject: 0.5 } },
	]);
	assert.deepEqual(
		evaluation.records.map((record) => record.score),
		[0.5, 0.5],
	);
	assert.deepEqual(evaluation.belowBar, ["claude-code: suite score 0.50 does not reach --min-score 0.90"]);
	assert.deepEqual(evaluation.invalid, []);
	assert.equal(evaluation.outDir, path.join(box.root, "results"));
	assert.equal(JSON.parse(fs.readFileSync(path.join(evaluation.outDir, "results.json"), "utf8")).records.length, 2);
	assert.deepEqual(seen, ["subject1", "subject2"]);
	assert.deepEqual(
		printed.map((method) => method.mock.callCount()),
		[0, 0],
	);

	await assert.rejects(evaluate({ cwd: box.root, subjects: [] }), { name: "UsageError" });
	await assert.rejects(evaluate({ cwd: box.root, subjects: ["mine"], reps: 0 }), { name: "UsageError" });
	assert.deepEqual(
		loadCases(path.join(box.root, "evals/cases")).map((caseDef) => caseDef.id),
		["hello"],
	);
	assert.deepEqual(
		HARNESSES.map((harness) => harness.id),
		["pi", "claude-code", "cursor", "opencode", "codex"],
	);
});

test("on win32 the CLI exits 2 with one line", async (t) => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "win32" });
	t.after(() => Object.defineProperty(process, "platform", platform));
	const error = t.mock.method(console, "error", () => {});

	assert.equal(await main(["list"]), 2);
	assert.deepEqual(
		error.mock.calls.map((call) => call.arguments),
		[["skill-evals: Windows is not supported; use macOS, Linux, or WSL"]],
	);
});
