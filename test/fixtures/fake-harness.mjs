#!/usr/bin/env node
// Stands in for a harness binary behind the Claude Code adapter: no model, and a Claude Code shaped stream.
// - Given the judge's prompt, it is the judge: it appends its prompt and model to `prompts.jsonl` in $FAKE_JUDGE_DIR
//   and replies with the next unused entry of `replies.json` there.
// - Given --plugin-dir, it behaves as `behavior.json` in that directory says (a plugin without one is plain).
// - It lists the skills installed in its config directory at startup, unless $FAKE_HIDE_SKILLS is set, and loads
//   each one that the prompt names.
import fs from "node:fs";
import path from "node:path";

const flag = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const emit = (event) => console.log(JSON.stringify(event));
const finish = (result, costUsd) =>
	emit({
		type: "result",
		subtype: "success",
		is_error: false,
		result,
		total_cost_usd: costUsd,
		usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 },
	});

const prompt = process.argv[process.argv.indexOf("--") + 1];
const pluginDir = flag("--plugin-dir");

if (prompt.startsWith("Grade one answer")) {
	const dir = process.env.FAKE_JUDGE_DIR;
	const replies = JSON.parse(fs.readFileSync(path.join(dir, "replies.json"), "utf8"));
	const log = path.join(dir, "prompts.jsonl");
	const asked = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").length : 0;
	fs.appendFileSync(log, `${JSON.stringify({ prompt, model: flag("--model"), pluginDir })}\n`);
	emit({ type: "system", subtype: "init", plugins: [], skills: [] });
	finish(replies[asked], 0.002);
	process.exit(0);
}

const behaviorFile = pluginDir && path.join(pluginDir, "behavior.json");
const behavior = behaviorFile && fs.existsSync(behaviorFile) ? JSON.parse(fs.readFileSync(behaviorFile, "utf8")) : { name: "plain" };
const skillsDir = path.join(process.env.CLAUDE_CONFIG_DIR, "skills");
const installed = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).sort() : [];

emit({
	type: "system",
	subtype: "init",
	plugins: pluginDir ? [{ name: "plugin", path: behavior.ghost ? "/nowhere/else" : pluginDir }] : [],
	skills: process.env.FAKE_HIDE_SKILLS ? [] : installed,
});
const used = [...(behavior.skill ? [`plugin:${behavior.skill}`] : []), ...installed.filter((name) => prompt.includes(name))];
for (const skill of used) {
	emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill } }] } });
}

fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/summary.txt", `summary by ${behavior.name}\n`);

const seen = {
	seed: fs.existsSync("notes.txt") ? fs.readFileSync("notes.txt", "utf8").trim() : "missing",
	leaks: Object.keys(process.env).filter((key) => key.startsWith("SKILL_EVALS_")).length,
	home: process.env.HOME,
	cwd: process.cwd(),
	prompt,
	model: flag("--model"),
	skills: Object.fromEntries(installed.map((name) => [name, fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8")])),
};
finish(behavior.answer ?? JSON.stringify(seen), behavior.costUsd);
