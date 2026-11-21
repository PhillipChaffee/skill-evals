import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HARNESSES, selectHarnesses } from "../src/harnesses/index.mjs";
import { checkScore } from "../src/cases.mjs";
import { skillsLoaded } from "../src/run.mjs";

const fixturesDir = path.join(import.meta.dirname, "fixtures");
const fakeHarness = path.join(fixturesDir, "fake-harness.mjs");
const parse = (id, fixture) =>
	HARNESSES.find((harness) => harness.id === id).parse(fs.readFileSync(path.join(fixturesDir, fixture), "utf8"));

const plainWords = "In plain words: it keeps fixing things until they match.";

// Every stream below was captured from the real CLI, with ids and paths scrubbed. For pi, opencode, and codex the
// CLI was driven by a scripted local model endpoint. cursor.stream.jsonl is the one exception: it is the example
// sequence from Cursor's output-format documentation, because no authenticated Cursor CLI was available.
const STREAMS = [
	{
		id: "claude-code",
		fixture: "claude-code.stream.jsonl",
		finalText: /^A reconciler is a program .* changes nothing\.$/,
		toolCalls: [{ name: "Skill", kind: "skill", input: { skill: "magic:bro", args: "The idempotent reconciler converges state." } }],
		skills: ["bro"],
		tokens: { input: 4 + 73969 + 16918, output: 378 },
		costUsd: 0.00431269,
		kitPaths: ["/work/kit-9fq1", "/tmp/home-4c1d/.claude/plugins/synced/design"],
	},
	{
		id: "pi",
		fixture: "pi.stream.jsonl",
		finalText: plainWords,
		toolCalls: [{ name: "read", kind: "read", input: { path: "/work/kit-9fq1/skills/bro/SKILL.md" } }],
		skills: ["bro"],
		tokens: { input: 2400, output: 68 },
		costUsd: 0,
		kitPaths: null,
	},
	{
		id: "opencode",
		fixture: "opencode.stream.jsonl",
		finalText: plainWords,
		toolCalls: [{ name: "skill", kind: "skill", input: { name: "bro" } }],
		skills: ["bro"],
		tokens: { input: 2400, output: 68 },
		costUsd: 0,
		kitPaths: null,
	},
	{
		id: "codex",
		fixture: "codex.stream.jsonl",
		finalText: plainWords,
		toolCalls: [
			{
				name: "command_execution",
				kind: "shell",
				input: { command: "/bin/bash -lc 'cat /tmp/home-4c1d/.codex/plugins/cache/magic-dev/magic/0.2.0/skills/bro/SKILL.md'" },
			},
		],
		skills: ["bro"],
		tokens: { input: 2400, output: 68 },
		costUsd: null,
		kitPaths: null,
	},
	{
		id: "cursor",
		fixture: "cursor.stream.jsonl",
		finalText: "Done! I've created the summary in summary.txt",
		toolCalls: [
			{ name: "read", kind: "read", input: { path: "README.md" } },
			{
				name: "write",
				kind: "write",
				input: {
					path: "summary.txt",
					fileText: "# README Summary\n\nThis project contains...",
					toolCallId: "toolu_vrtx_01Q3VHVnWFSKygaRPT7WDxrv",
				},
			},
		],
		skills: [],
		tokens: null,
		costUsd: null,
		kitPaths: null,
	},
];

for (const expected of STREAMS) {
	test(`${expected.id} adapter normalizes a successful stream`, () => {
		const parsed = parse(expected.id, expected.fixture);
		assert.equal(parsed.error, null);
		assert.match(parsed.finalText, expected.finalText instanceof RegExp ? expected.finalText : new RegExp(`^${expected.finalText}$`));
		assert.deepEqual(parsed.toolCalls, expected.toolCalls);
		assert.deepEqual(skillsLoaded(parsed.toolCalls), expected.skills);
		assert.deepEqual(parsed.tokens, expected.tokens);
		assert.equal(parsed.costUsd, expected.costUsd);
		assert.deepEqual(parsed.kitPaths, expected.kitPaths);
	});
}

const FAILURES = [
	{ id: "pi", fixture: "pi-error.stream.jsonl", error: /security token included in the request is invalid/ },
	{ id: "opencode", fixture: "opencode-error.stream.jsonl", error: /Unexpected server error/ },
	{ id: "codex", fixture: "codex-error.stream.jsonl", error: /^unexpected status 401 Unauthorized/ },
];

for (const { id, fixture, error } of FAILURES) {
	test(`${id} adapter reports the harness's own error for a failed stream`, () => {
		const parsed = parse(id, fixture);
		assert.match(parsed.error, error);
		assert.equal(parsed.finalText, "");
	});
}

test("every adapter reports an error, not an empty success, when the stream has no terminal event", () => {
	for (const harness of HARNESSES) {
		assert.equal(typeof harness.parse("warming up\n").error, "string", harness.id);
	}
});

test("a skill counts as loaded through the harness's skill tool or a read of its SKILL.md, and through nothing else", () => {
	const loaded = skillsLoaded([
		{ name: "Skill", kind: "skill", input: { skill: "magic:bro" } },
		{ name: "skill", kind: "skill", input: { id: "how" } },
		{ name: "Read", kind: "read", input: { file_path: "/kits/k1/skills/why/skill.md" } },
		{ name: "Bash", kind: "shell", input: { command: "ls skills && cat notes/SKILL.md" } },
		{ name: "Grep", kind: "search", input: { pattern: "bro", path: "skills/" } },
		{ name: "write", kind: "write", input: { path: "skill.md", name: "sharpen" } },
	]);
	assert.deepEqual(loaded, ["bro", "how", "why"]);
});

test("a tool check finds a call by neutral kind in every harness, by native name, and by its input", () => {
	const score = (id, fixture, check) => checkScore(check, { toolCalls: parse(id, fixture).toolCalls });
	const streams = [
		["claude-code", "claude-code-tools.stream.jsonl"],
		["codex", "codex.stream.jsonl"],
		["cursor", "cursor.stream.jsonl"],
	];
	// The Claude Code stream is a captured run that used every tool below; the kinds it lacks are false in all three.
	const called = {
		shell: [1, 1, 0],
		read: [1, 0, 1],
		write: [1, 0, 1],
		edit: [1, 0, 0],
		web: [1, 0, 0],
		subagent: [1, 0, 0],
		search: [0, 0, 0],
	};
	for (const [kind, expected] of Object.entries(called)) {
		const scores = (type) => streams.map(([id, fixture]) => score(id, fixture, { type, kind }));
		assert.deepEqual(scores("tool_called"), expected, kind);
		assert.deepEqual(
			scores("tool_not_called"),
			expected.map((found) => 1 - found),
			kind,
		);
	}

	const codex = (check) => score("codex", "codex.stream.jsonl", check);
	assert.equal(codex({ type: "tool_called", name: "^command_execution$" }), 1);
	assert.equal(codex({ type: "tool_called", name: "^COMMAND", flags: "i" }), 1);
	assert.equal(codex({ type: "tool_called", name: "^Bash$" }), 0);
	assert.equal(codex({ type: "tool_called", kind: "shell", inputMatches: "cat .*SKILL\\.md" }), 1);
	assert.equal(codex({ type: "tool_called", kind: "shell", inputMatches: "rm -rf" }), 0);
	assert.equal(codex({ type: "tool_called", kind: "edit", inputMatches: "cat .*SKILL\\.md" }), 0);
	assert.equal(codex({ type: "tool_not_called", kind: "shell", inputMatches: "rm -rf" }), 1);
});

test("a tool name that an adapter's table lacks, an inherited property name included, has the kind other", () => {
	const stream = (name) => JSON.stringify({ type: "tool_execution_start", toolName: name, args: {} });
	const kinds = HARNESSES.find((harness) => harness.id === "pi")
		.parse(["mcp_lookup", "constructor", "bash"].map(stream).join("\n"))
		.toolCalls.map((call) => call.kind);
	assert.deepEqual(kinds, ["other", "other", "shell"]);
});

test("the default harness is the first installed one in preference order", () => {
	const only = (...ids) => ({
		PATH: "",
		...Object.fromEntries(ids.map((id) => [`SKILL_EVALS_BIN_${id.toUpperCase().replace("-", "_")}`, fakeHarness])),
	});
	const chosen = (spec, env) => selectHarnesses(spec, env).chosen.map(({ harness }) => harness.id);

	assert.deepEqual(chosen(undefined, only("codex", "opencode")), ["opencode"]);
	assert.deepEqual(chosen(undefined, only("codex", "cursor", "claude-code")), ["claude-code"]);
	assert.deepEqual(chosen(undefined, only("codex", "claude-code", "pi")), ["pi"]);
	assert.deepEqual(chosen("all", only("codex", "pi")), ["pi", "codex"]);
	assert.deepEqual(chosen("codex,pi", only("codex", "pi", "cursor")), ["codex", "pi"]);
	assert.throws(() => chosen(undefined, only()), /no harness is installed/);
	assert.throws(() => chosen("cursor", only("pi")), /not installed/);
	assert.throws(() => chosen("emacs", only("pi")), /unknown harness/);
});
