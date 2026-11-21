import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {typeof TOOL_KINDS[number]} ToolKind
 * @typedef {{ name: string, kind: ToolKind, input: unknown }} ToolCall
 *   name is the harness's own tool name; kind is what the tool does, the same word in every harness
 * @typedef {{ input: number, output: number }} Tokens  input counts every prompt token, cached ones included
 * @typedef {{ finalText: string, toolCalls: ToolCall[], tokens: Tokens | null, costUsd: number | null,
 *   loaded: { paths: string[] | null, skills: string[] | null }, error: string | null }} Parsed
 *   null means the harness does not report the field; loaded is what the harness says it loaded at startup:
 *   the directories of its plugins and the names of its skills
 * @typedef {{ args: string[], env: Record<string, string>, setup?: string[][], stdin?: string }} Invocation
 *   setup lists argument vectors to run with the same binary and environment before the prompt;
 *   stdin is written to the harness's standard input, for a harness that takes its prompt there
 * @typedef {Pick<import("../subject.mjs").Subject, "kind" | "dir" | "skills" | "skillDirs">} LoadedSubject
 * @typedef {{ subject: LoadedSubject | null, home: string, workspace: string, prompt: string, model?: string,
 *   maxTurns?: number }} RunInput
 *   subject is a plugin or a skills folder, or null to load nothing; home is the run's throwaway HOME, with the XDG
 *   directories at their defaults under it
 * @typedef {{ id: string, bin: string, authFiles: string[],
 *   invocation: (input: RunInput) => Invocation, parse: (stdout: string) => Parsed }} Harness
 */

export const TOOL_KINDS = /** @type {const} */ (["shell", "read", "write", "edit", "search", "web", "skill", "subagent", "other"]);

/** Builds a ToolCall from an adapter's table of native tool name -> kind; a name the table lacks is "other". */
export const toolCall = (kinds, name, input) => ({ name, kind: Object.hasOwn(kinds, name) ? kinds[name] : "other", input });

export function jsonLines(stdout) {
	const events = [];
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// A log line that happens to start with a brace; the stream itself is one object per line.
		}
	}
	return events;
}

/** The directory of a plugin subject, and null for every other subject. */
export const pluginDir = (subject) => (subject?.kind === "plugin" ? subject.dir : null);

const NOT_SKILL_CONTENT = new Set([".git", "node_modules"]);

/**
 * Copies each skill of a skills subject to `<dir>/<name>/`, so the path the agent sees is inside the throwaway home.
 * Does nothing for any other subject.
 * @returns {string[]} the copies
 */
export function placeSkills(subject, dir) {
	if (subject?.kind !== "skills") return [];
	return subject.skills.map((name) => {
		const target = path.join(dir, name);
		fs.cpSync(subject.skillDirs[name], target, {
			recursive: true,
			dereference: true,
			filter: (source) => !NOT_SKILL_CONTENT.has(path.basename(source)),
		});
		return target;
	});
}

export const opt = (flag, value) => (value == null ? [] : [flag, String(value)]);

export function sumTokens(usages) {
	if (usages.length === 0) return null;
	return usages.reduce((total, u) => ({ input: total.input + u.input, output: total.output + u.output }), { input: 0, output: 0 });
}
