/**
 * @typedef {typeof TOOL_KINDS[number]} ToolKind
 * @typedef {{ name: string, kind: ToolKind, input: unknown }} ToolCall
 *   name is the harness's own tool name; kind is what the tool does, the same word in every harness
 * @typedef {{ input: number, output: number }} Tokens  input counts every prompt token, cached ones included
 * @typedef {{ finalText: string, toolCalls: ToolCall[], tokens: Tokens | null, costUsd: number | null,
 *   kitPaths: string[] | null, error: string | null }} Parsed  null means the harness does not report the field
 * @typedef {{ args: string[], env: Record<string, string>, setup?: string[][] }} Invocation
 *   setup lists argument vectors to run with the same binary and environment before the prompt
 * @typedef {{ kitDir: string | null, home: string, workspace: string, prompt: string, model?: string, maxTurns?: number }} RunInput
 *   kitDir null means no kit at all; home is the run's throwaway HOME, with the XDG directories at their defaults under it
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

export const opt = (flag, value) => (value == null ? [] : [flag, String(value)]);

export function sumTokens(usages) {
	if (usages.length === 0) return null;
	return usages.reduce((total, u) => ({ input: total.input + u.input, output: total.output + u.output }), { input: 0, output: 0 });
}
