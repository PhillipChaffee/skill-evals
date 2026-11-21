import path from "node:path";
import { jsonLines, opt, sumTokens, toolCall } from "./shared.mjs";

const KINDS = { bash: "shell", read: "read", write: "write", edit: "edit", grep: "search", find: "search", ls: "search" };
const FAILED = new Set(["error", "aborted"]);

/** @type {import("./shared.mjs").Harness} */
export default {
	id: "pi",
	bin: "pi",
	authFiles: [".pi/agent/auth.json", ".pi/agent/models.json"],

	invocation({ kitDir, home, prompt, model }) {
		return {
			// -ne, -ns and -np switch off discovery, so the kit that -e names is the only one loaded.
			args: ["-p", "--mode", "json", "--no-session", "-ne", "-ns", "-np", ...opt("-e", kitDir), ...opt("--model", model), prompt],
			env: { PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"), PI_OFFLINE: "1" },
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
			kitPaths: null,
			error: !last ? "no turn_end event" : FAILED.has(last.stopReason) ? last.errorMessage || last.stopReason : null,
		};
	},
};
