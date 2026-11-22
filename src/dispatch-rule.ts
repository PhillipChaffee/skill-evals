import { GENERIC_AGENT, normalizeAgent } from "./agents.js";
import type { ToolCall } from "./harnesses/shared.js";

export const DEFAULT_WINDOW = 400;
const NAME_LINE = /^\s*name:\s*["']?([^\s"']+)["']?\s*$/m;
const SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** How a dispatch was found to start the agent. */
export type Rule = "type" | "inlined definition";

/**
 * Reads the brief of a dispatch call.
 * @param call - A call of kind `subagent`.
 * @returns The text of its input's `prompt`, then its `description`, one on each line; empty when it has neither.
 */
export function briefOf(call: ToolCall): string {
  const given = Object(call.input) as Record<string, unknown>;
  return ["prompt", "description"]
    .flatMap((key) => (typeof given[key] === "string" ? [given[key]] : []))
    .join("\n");
}

/**
 * Names the type a dispatch asked for.
 * @param call - A call of kind `subagent`.
 * @returns The normalized type; empty when the dispatch names none.
 */
export const typeOf = (call: ToolCall): string =>
  normalizeAgent(call.dispatch?.type ?? "");

/**
 * Finds how a dispatch starts an agent, if it does.
 * @param call - A call of kind `subagent`.
 * @param agent - The agent's normalized name.
 * @param window - How far into the brief the bare name counts.
 * @returns `type` when the dispatch's type is the agent. Only for a dispatch of no type or the generic one:
 *   `inlined definition` when the first line `name: <x>` anywhere in the brief names the agent; with no such line, when
 *   the name is a whole word in the first `window` characters of it; otherwise null.
 */
export function ruleOf(
  call: ToolCall,
  agent: string,
  window = DEFAULT_WINDOW,
): Rule | null {
  const type = typeOf(call);
  if (type === agent) return "type";
  if (type !== "" && type !== GENERIC_AGENT) return null;
  const brief = briefOf(call);
  const named = NAME_LINE.exec(brief)?.[1];
  // A `name:` line settles it: the first one decides, and the bare name is not looked for.
  if (named !== undefined) {
    return normalizeAgent(named) === agent ? "inlined definition" : null;
  }
  const name = agent.replace(SPECIAL, "\\$&");
  const alone = new RegExp(`(?<![\\w-])${name}(?![\\w-])`);
  return alone.test(brief.slice(0, window)) ? "inlined definition" : null;
}
