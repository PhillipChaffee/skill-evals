import path from "node:path";
import { jsonLines, opt, placeSkills, pluginDir, toolCall } from "./shared.mjs";

const KINDS = {
	shell: "shell",
	read: "read",
	write: "write",
	edit: "edit",
	delete: "edit",
	grep: "search",
	glob: "search",
	ls: "search",
	semSearch: "search",
	webSearch: "web",
	webFetch: "web",
	task: "subagent",
};

function nativeCall(call) {
	const [key, body] = Object.entries(call)[0];
	if (key !== "function") return toolCall(KINDS, key.replace(/ToolCall$/, ""), body.args);
	try {
		return toolCall(KINDS, body.name, JSON.parse(body.arguments));
	} catch {
		return toolCall(KINDS, body.name, body.arguments);
	}
}

/** @type {import("./shared.mjs").Harness} */
export default {
	id: "cursor",
	bin: "cursor-agent",
	authFiles: [".cursor/auth.json", ".config/cursor/auth.json"],

	invocation({ subject, home, workspace, prompt, model }) {
		placeSkills(subject, path.join(home, ".cursor", "skills"));
		return {
			args: [
				"-p",
				"--output-format",
				"stream-json",
				...opt("--plugin-dir", pluginDir(subject)),
				"--force",
				"--trust",
				"--workspace",
				workspace,
				...opt("--model", model),
				"--",
				prompt,
			],
			env: { CURSOR_CONFIG_DIR: path.join(home, ".cursor") },
		};
	},

	parse(stdout) {
		const events = jsonLines(stdout);
		const result = events.findLast((e) => e.type === "result");
		const lastMessage = events.findLast((e) => e.type === "assistant");
		return {
			// result.result joins every message of the run; the last assistant event is the final one.
			finalText: lastMessage ? lastMessage.message.content.map((part) => part.text ?? "").join("") : (result?.result ?? ""),
			toolCalls: events.filter((e) => e.type === "tool_call" && e.subtype === "started").map((e) => nativeCall(e.tool_call)),
			tokens: null,
			costUsd: null,
			loaded: { paths: null, skills: null },
			error: !result ? "no result event" : result.is_error ? result.result || result.subtype : null,
		};
	},
};
