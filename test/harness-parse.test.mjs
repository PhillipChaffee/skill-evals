import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
		loaded: { paths: ["/work/kit-9fq1", "/tmp/home-4c1d/.claude/plugins/synced/design"], skills: null },
	},
	{
		id: "pi",
		fixture: "pi.stream.jsonl",
		finalText: plainWords,
		toolCalls: [{ name: "read", kind: "read", input: { path: "/work/kit-9fq1/skills/bro/SKILL.md" } }],
		skills: ["bro"],
		tokens: { input: 2400, output: 68 },
		costUsd: 0,
	},
	{
		id: "opencode",
		fixture: "opencode.stream.jsonl",
		finalText: plainWords,
		toolCalls: [{ name: "skill", kind: "skill", input: { name: "bro" } }],
		skills: ["bro"],
		tokens: { input: 2400, output: 68 },
		costUsd: 0,
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
		assert.deepEqual(parsed.loaded, expected.loaded ?? { paths: null, skills: null });
	});
}

test("claude-code reports the skills it listed at startup, without a plugin prefix", () => {
	const init = { type: "system", subtype: "init", plugins: [], skills: ["magic:bro", "greet"] };
	const { loaded } = HARNESSES.find((harness) => harness.id === "claude-code").parse(JSON.stringify(init));
	assert.deepEqual(loaded, { paths: [], skills: ["bro", "greet"] });
});

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

/** What each adapter's `invocation` does with a subject, in a throwaway home. */
function invoke(t, id, subject, prompt = "say hello") {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "home-")));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	const harness = HARNESSES.find((candidate) => candidate.id === id);
	return { home, ...harness.invocation({ subject, home, workspace: home, prompt }) };
}

function skillsSubject(t) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skills-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.mkdirSync(path.join(dir, "greet"));
	fs.writeFileSync(path.join(dir, "greet/SKILL.md"), "Say hello.\n");
	return { kind: "skills", dir, skills: ["greet"], skillDirs: { greet: path.join(dir, "greet") } };
}

// Where each harness discovers a skill of its user, relative to the home directory.
const SKILL_HOMES = {
	"claude-code": ".claude/skills",
	cursor: ".cursor/skills",
	codex: ".agents/skills",
	opencode: ".agents/skills",
	pi: ".pi/agent/skills",
};

test("each adapter places a skills subject where its harness discovers skills", (t) => {
	const subject = skillsSubject(t);
	assert.deepEqual(Object.keys(SKILL_HOMES).sort(), HARNESSES.map((harness) => harness.id).sort());
	for (const [id, skillHome] of Object.entries(SKILL_HOMES)) {
		const { home, args } = invoke(t, id, subject);
		const copy = path.join(home, skillHome, "greet");
		assert.equal(fs.readFileSync(path.join(copy, "SKILL.md"), "utf8"), "Say hello.\n", id);
		assert.equal(fs.lstatSync(copy).isSymbolicLink(), false, id);
		assert.ok(!args.includes(subject.dir), `${id} must not point the harness at the folder itself`);
	}
	// Pi runs with skill discovery off, so it has to be told about each copy.
	const pi = invoke(t, "pi", subject);
	assert.equal(pi.args[pi.args.indexOf("--skill") + 1], path.join(pi.home, ".pi/agent/skills/greet"));
});

test("an adapter places no skills for a plugin subject or for no subject", (t) => {
	const plugin = { ...skillsSubject(t), kind: "plugin" };
	// Codex installs a plugin from its marketplace file, which this bare directory lacks.
	for (const id of Object.keys(SKILL_HOMES).filter((id) => id !== "codex")) {
		for (const subject of [plugin, null]) {
			const { home } = invoke(t, id, subject);
			assert.equal(fs.existsSync(path.join(home, SKILL_HOMES[id])), false, id);
		}
	}
});

test("each adapter keeps a prompt that starts with a dash as the prompt", (t) => {
	const prompt = "--help me";
	for (const { id } of HARNESSES) {
		const { args, stdin } = invoke(t, id, null, prompt);
		if (stdin === undefined) assert.deepEqual(args.slice(-2), ["--", prompt], id);
		else assert.deepEqual([stdin, args.includes(prompt)], [prompt, false], id);
	}
});
