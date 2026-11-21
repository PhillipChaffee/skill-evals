import fs from "node:fs";
import path from "node:path";
import { jsonLines, opt, sumTokens, toolCall } from "./shared.mjs";

const KINDS = {
	bash: "shell",
	read: "read",
	write: "write",
	edit: "edit",
	patch: "edit",
	grep: "search",
	glob: "search",
	list: "search",
	webfetch: "web",
	websearch: "web",
	skill: "skill",
	task: "subagent",
};

/** @type {import("./shared.mjs").Harness} */
export default {
	id: "opencode",
	bin: "opencode",
	authFiles: [".local/share/opencode/auth.json"],

	invocation({ kitDir, home, workspace, prompt, model }) {
		const configDir = path.join(home, ".config", "opencode");
		fs.mkdirSync(configDir, { recursive: true });
		// V1 reads "plugin" and ignores "plugins" (seen on 1.19.6); V2 is documented to read "plugins".
		const kits = kitDir ? [kitDir] : [];
		fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({ plugin: kits, plugins: kits }));
		return { args: ["run", "--format", "json", "--auto", "--dir", workspace, ...opt("-m", model), prompt], env: {} };
	},

	parse(stdout) {
		const events = jsonLines(stdout);
		const steps = events.filter((e) => e.type === "step_finish").map((e) => e.part);
		const failure = events.find((e) => e.type === "error")?.error;
		return {
			finalText: events
				.slice(events.findLastIndex((e) => e.type === "step_start") + 1)
				.filter((e) => e.type === "text")
				.map((e) => e.part.text)
				.join(""),
			toolCalls: events.filter((e) => e.type === "tool_use").map((e) => toolCall(KINDS, e.part.tool, e.part.state?.input)),
			tokens: sumTokens(
				steps.map(({ tokens }) => ({ input: tokens.input + tokens.cache.read + tokens.cache.write, output: tokens.output })),
			),
			costUsd: steps.length ? steps.reduce((total, step) => total + (step.cost ?? 0), 0) : null,
			kitPaths: null,
			error: failure ? failure.data?.message || failure.name || "error" : steps.length ? null : "no step_finish event",
		};
	},
};
