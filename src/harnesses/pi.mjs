import path from "node:path";
import { jsonLines, opt, placeSkills, pluginDir, sumTokens, toolCall } from "./shared.mjs";

const KINDS = { bash: "shell", read: "read", write: "write", edit: "edit", grep: "search", find: "search", ls: "search" };
const FAILED = new Set(["error", "aborted"]);

/** @type {import("./shared.mjs").Harness} */
export default {
	id: "pi",
	bin: "pi",
	authFiles: [".pi/agent/auth.json", ".pi/agent/models.json"],

	invocation({ subject, home, prompt, model }) {
		const agentDir = path.join(home, ".pi", "agent");
		const skills = placeSkills(subject, path.join(agentDir, "skills"));
		return {
			args: [
				"-p",
				"--mode",
				"json",
				"--no-session",
				// -ne, -ns and -np switch off discovery, so what -e and --skill name is all that loads.
				"-ne",
				"-ns",
				"-np",
				...opt("-e", pluginDir(subject)),
				...skills.flatMap((dir) => ["--skill", dir]),
				...opt("--model", model),
			],
			// Pi has no `--` separator and reads a leading `-` or `@` in a message argument as a flag or a file.
			stdin: prompt,
			env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		};
	},

	parse(stdout) {
		const events = jsonLines(stdout);
		const turns = events
			.filter((e) => e.type === "turn_end")
			.map((e) => e.message)
			.filter((message) => message?.role === "assistant");
		const last = turns.at(-1);
		const usages = turns.map((message) => message.usage).filter(Boolean);
		return {
			finalText: (last?.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(""),
			toolCalls: events.filter((e) => e.type === "tool_execution_start").map((e) => toolCall(KINDS, e.toolName, e.args)),
			tokens: sumTokens(usages.map((u) => ({ input: u.input + u.cacheRead + u.cacheWrite, output: u.output }))),
			costUsd: usages.length ? usages.reduce((total, u) => total + (u.cost?.total ?? 0), 0) : null,
			loaded: { paths: null, skills: null },
			error: !last ? "no turn_end event" : FAILED.has(last.stopReason) ? last.errorMessage || last.stopReason : null,
		};
	},
};
