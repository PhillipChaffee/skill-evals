import { GENERIC_AGENT, normalizeAgent } from "../agents.js";
import type { ToolCall } from "../harnesses/shared.js";
import { checkBounds } from "./bounds.js";
import type { RuledCheck, Spec, Verdict } from "./index.js";
import { PASS, regex } from "./rules.js";

const DEFAULT_WINDOW = 400;
const SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** How a dispatch was found to start the agent. */
type Rule = "type" | "inlined definition";

/**
 * Reads the brief of a dispatch call.
 * @param call - A call of kind `subagent`.
 * @returns The text of its input's `prompt`, then its `description`, one on each line; empty when it has neither.
 */
function briefOf(call: ToolCall): string {
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
const typeOf = (call: ToolCall): string =>
  normalizeAgent(call.dispatch?.type ?? "");

/**
 * Finds how a dispatch starts an agent, if it does.
 * @param call - A call of kind `subagent`.
 * @param agent - The agent's normalized name.
 * @param window - How far into the brief the bare name counts.
 * @returns `type` when the dispatch's type is the agent. Only for a dispatch of no type or the generic one:
 *   `inlined definition` when a line `name: <agent>` is anywhere in the brief, or the name is a whole word in the first
 *   `window` characters of it; otherwise null.
 */
function ruleOf(call: ToolCall, agent: string, window: number): Rule | null {
  const type = typeOf(call);
  if (type === agent) return "type";
  if (type !== "" && type !== GENERIC_AGENT) return null;
  const brief = briefOf(call);
  const name = agent.replace(SPECIAL, "\\$&");
  const alone = `(?<![\\w-])${name}(?![\\w-])`;
  const line = new RegExp(`^\\s*name:\\s*["']?${name}["']?\\s*$`, "m");
  return line.test(brief) || new RegExp(alone).test(brief.slice(0, window))
    ? "inlined definition"
    : null;
}

/** What a dispatch must be to count. */
interface Wants {
  agent: string;
  window: number;
  brief: RegExp | null;
  model: RegExp | null;
}

/**
 * Judges one dispatch.
 * @param call - A call of kind `subagent`.
 * @param wants - What the check asks of a dispatch.
 * @returns The rule by which it starts the agent; `no model` when it fits but carries no model for `modelMatches`;
 *   null when it does not count.
 */
function judge(call: ToolCall, wants: Wants): Rule | "no model" | null {
  const rule = ruleOf(call, wants.agent, wants.window);
  if (rule === null || (wants.brief && !wants.brief.test(briefOf(call)))) {
    return null;
  }
  if (!wants.model) return rule;
  const chosen = call.dispatch?.model ?? null;
  if (chosen === null) return "no model";
  return wants.model.test(chosen) ? rule : null;
}

/**
 * Scores the dispatches of an agent against the count bounds.
 * @param check - An `agent_dispatched` check.
 * @param calls - Every tool call of the run.
 * @returns 1 when the number of matching dispatches is from `min` to `max`, with the rule that matched; else the reason.
 */
function dispatched(check: RuledCheck, calls: ToolCall[]): Verdict {
  const flags = check.flags ?? "";
  const pattern = (source: string | undefined) =>
    source ? regex(source, flags) : null;
  const wants = {
    agent: normalizeAgent(check.agent as string),
    window: check.briefWindow ?? DEFAULT_WINDOW,
    brief: pattern(check.briefMatches),
    model: pattern(check.modelMatches),
  };
  const dispatches = calls.filter((call) => call.kind === "subagent");
  const judged = dispatches.map((call) => judge(call, wants));
  const found = [...new Set(judged.filter((one) => one !== null))];
  const rules = found.filter((one) => one !== "no model");
  const count = judged.filter(
    (one) => one !== null && one !== "no model",
  ).length;
  const min = check.min ?? (check.max === 0 ? 0 : 1);
  const max = check.max ?? Infinity;
  const noun = `${String(count)} matching ${count === 1 ? "dispatch" : "dispatches"} of ${wants.agent}`;
  if (count >= min && count <= max) {
    return {
      ...PASS,
      reason: count === 0 ? noun : `${noun}, matched by ${rules.join(" and ")}`,
    };
  }
  const seen = dispatches.map((call) => typeOf(call) || GENERIC_AGENT);
  return {
    score: 0,
    reason: [
      `${noun}, ${count < min ? `min ${String(min)}` : `max ${String(max)}`}`,
      ...(found.includes("no model") ? ["the dispatch carries no model"] : []),
      `dispatched: ${seen.length === 0 ? "(nothing)" : seen.join(", ")}`,
    ].join("; "),
  };
}

// The check of the agents that the run started.
export const DISPATCH_CHECKS = {
  agent_dispatched: {
    fields: ["agent"],
    optional: [
      "min",
      "max",
      "briefMatches",
      "flags",
      "briefWindow",
      "modelMatches",
    ],
    scores:
      "The number of dispatches that start the agent is from `min` to `max`, and each one's brief fits `briefMatches` and its model fits `modelMatches`, where given.",
    note: "A dispatch starts the agent when its type, normalized, is the `agent` (`matched by type`). A dispatch of no type, or of `general-purpose`, starts it when its brief holds a line `name: <agent>` anywhere, or the agent name as a whole word in the first `briefWindow` (default 400) characters (`matched by inlined definition`); a dispatch with a type of its own is judged by the type alone. The brief is the dispatch's `prompt` text, then its `description`. A dispatch that carries no model does not match `modelMatches`, and the reason says so. `min` defaults to 1, and to 0 when `max` is 0. Needs a harness with `subagents`.",
    needs: () => ["subagents"],
    validate: checkBounds,
    rule: (check, outcome) => dispatched(check, outcome.toolCalls),
  },
} satisfies Record<string, Spec>;
