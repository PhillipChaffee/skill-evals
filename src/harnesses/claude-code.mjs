import path from "node:path";
import { jsonLines, opt, toolCall } from "./shared.mjs";

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

	invocation({ kitDir, home, prompt, model, maxTurns }) {
		return {
			// Never --bare: it switches off the plugin hooks the kit ships.
			args: [
				"-p",
				prompt,
				...opt("--plugin-dir", kitDir),
				"--output-format",
				"stream-json",
				"--verbose",
				"--permission-mode",
				"bypassPermissions",
				...opt("--model", model),
				...opt("--max-turns", maxTurns),
			],
			env: { CLAUDE_CONFIG_DIR: path.join(home, ".claude") },
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
			kitPaths: init?.plugins ? init.plugins.map((plugin) => plugin.path) : null,
			error: !result ? "no result event" : result.is_error ? result.result || result.subtype : null,
		};
	},
};
