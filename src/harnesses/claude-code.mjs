import path from "node:path";
import { jsonLines, opt, placeSkills, pluginDir, toolCall } from "./shared.mjs";

const KINDS = {
	Bash: "shell",
	Read: "read",
	Write: "write",
	Edit: "edit",
	NotebookEdit: "edit",
	Grep: "search",
	Glob: "search",
	WebFetch: "web",
	WebSearch: "web",
	Skill: "skill",
	Agent: "subagent",
	Task: "subagent",
};

/** @type {import("./shared.mjs").Harness} */
export default {
	id: "claude-code",
	bin: "claude",
	authFiles: [".claude/.credentials.json"],

	invocation({ subject, home, prompt, model, maxTurns }) {
		const configDir = path.join(home, ".claude");
		placeSkills(subject, path.join(configDir, "skills"));
		return {
			// Never --bare: it switches off the hooks a plugin ships.
			args: [
				"-p",
				...opt("--plugin-dir", pluginDir(subject)),
				"--output-format",
				"stream-json",
				"--verbose",
				"--permission-mode",
				"bypassPermissions",
				...opt("--model", model),
				...opt("--max-turns", maxTurns),
				"--",
				prompt,
			],
			env: { CLAUDE_CONFIG_DIR: configDir },
		};
	},

	parse(stdout) {
		const events = jsonLines(stdout);
		const init = events.find((e) => e.type === "system" && e.subtype === "init");
		const result = events.findLast((e) => e.type === "result");
		const usage = result?.usage;
		return {
			finalText: result?.result ?? "",
			toolCalls: events
				.filter((e) => e.type === "assistant")
				.flatMap((e) => e.message?.content ?? [])
				.filter((block) => block.type === "tool_use")
				.map(({ name, input }) => toolCall(KINDS, name, input)),
			tokens: usage
				? {
						input: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
						output: usage.output_tokens,
					}
				: null,
			costUsd: result?.total_cost_usd ?? null,
			loaded: {
				paths: init?.plugins ? init.plugins.map((plugin) => plugin.path) : null,
				// A plugin's skill is listed as `plugin:skill`.
				skills: init?.skills ? init.skills.map((name) => name.split(":").at(-1)) : null,
			},
			error: !result ? "no result event" : result.is_error ? result.result || result.subtype : null,
		};
	},
};
