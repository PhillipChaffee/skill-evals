import fs from "node:fs";
import path from "node:path";
import { jsonLines, opt, sumTokens, toolCall } from "./shared.mjs";

// Thread items that are tool calls, mapped to the part of the item that is the call's input (never its output).
const TOOL_ITEMS = {
	command_execution: (item) => ({ command: item.command }),
	file_change: (item) => ({ changes: item.changes }),
	mcp_tool_call: (item) => ({ server: item.server, tool: item.tool, arguments: item.arguments }),
	collab_tool_call: (item) => ({ tool: item.tool, prompt: item.prompt }),
	web_search: (item) => ({ query: item.query }),
};
const KINDS = { command_execution: "shell", file_change: "edit", web_search: "web", collab_tool_call: "subagent" };

// Codex has no flag that loads a checkout for one run, so install it into the throwaway home first.
function installKit(kitDir) {
	const marketplace = JSON.parse(fs.readFileSync(path.join(kitDir, ".agents/plugins/marketplace.json"), "utf8"));
	return [
		["plugin", "marketplace", "add", kitDir],
		["plugin", "add", `${marketplace.plugins[0].name}@${marketplace.name}`],
	];
}

/** @type {import("./shared.mjs").Harness} */
export default {
	id: "codex",
	bin: "codex",
	authFiles: [".codex/auth.json"],

	invocation({ kitDir, home, workspace, prompt, model }) {
		const codexHome = path.join(home, ".codex");
		fs.mkdirSync(codexHome, { recursive: true });
		return {
			setup: kitDir ? installKit(kitDir) : [],
			args: [
				"exec",
				"--json",
				"--skip-git-repo-check",
				"--dangerously-bypass-approvals-and-sandbox",
				"-C",
				workspace,
				...opt("-m", model),
				prompt,
			],
			env: { CODEX_HOME: codexHome },
		};
	},

	parse(stdout) {
		const events = jsonLines(stdout);
		const items = events.filter((e) => e.type === "item.completed").map((e) => e.item);
		const usages = events.filter((e) => e.type === "turn.completed").map((e) => e.usage);
		const failed = events.find((e) => e.type === "turn.failed");
		return {
			finalText: items.findLast((item) => item.type === "agent_message")?.text ?? "",
			toolCalls: items.filter((item) => item.type in TOOL_ITEMS).map((item) => toolCall(KINDS, item.type, TOOL_ITEMS[item.type](item))),
			tokens: sumTokens(usages.map((u) => ({ input: u.input_tokens, output: u.output_tokens }))),
			costUsd: null,
			kitPaths: null,
			error: failed ? failed.error?.message || "turn failed" : usages.length ? null : "no turn.completed event",
		};
	},
};
