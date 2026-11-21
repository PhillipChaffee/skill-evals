#!/usr/bin/env node
// Stands in for a harness binary: no model, a Claude Code shaped stream, and behavior read from
// `behavior.json` in the kit directory it is pointed at (a kit without one gets the plain behavior).
// Started with no kit, it is the judge: it appends its prompt and model to `prompts.jsonl` in $FAKE_JUDGE_DIR and
// replies with the next unused entry of `replies.json` there.
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

const kitDir = flag("--plugin-dir");
if (kitDir === null) {
	const dir = process.env.FAKE_JUDGE_DIR;
	const replies = JSON.parse(fs.readFileSync(path.join(dir, "replies.json"), "utf8"));
	const log = path.join(dir, "prompts.jsonl");
	const asked = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").length : 0;
	fs.appendFileSync(log, `${JSON.stringify({ prompt: flag("-p"), model: flag("--model") })}\n`);
	emit({ type: "system", subtype: "init", plugins: [] });
	finish(replies[asked], 0.002);
	process.exit(0);
}

const behaviorFile = path.join(kitDir, "behavior.json");
const behavior = fs.existsSync(behaviorFile) ? JSON.parse(fs.readFileSync(behaviorFile, "utf8")) : { name: "plain" };

emit({ type: "system", subtype: "init", plugins: [{ name: "kit", path: behavior.ghost ? "/nowhere/else" : kitDir }] });
if (behavior.skill) {
	const call = { type: "tool_use", name: "Skill", input: { skill: `kit:${behavior.skill}` } };
	emit({ type: "assistant", message: { content: [call] } });
}

fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/summary.txt", `summary by ${behavior.name}\n`);

const seen = {
	seed: fs.existsSync("notes.txt") ? fs.readFileSync("notes.txt", "utf8").trim() : "missing",
	leaks: Object.keys(process.env).filter((key) => key.startsWith("SKILL_EVALS_")).length,
	home: process.env.HOME,
	cwd: process.cwd(),
	prompt: flag("-p"),
};
finish(behavior.answer ?? JSON.stringify(seen), behavior.costUsd);
