import { GENERIC_AGENT, normalizeAgent } from "../agents.js";
import type { ToolCall } from "../harnesses/shared.js";
import { checkBounds } from "./bounds.js";
import type { RuledCheck, Spec, Verdict } from "./index.js";
import { PASS, regex } from "./rules.js";
import type { Rule } from "../dispatch-rule.js";
import { DEFAULT_WINDOW, briefOf, ruleOf, typeOf } from "../dispatch-rule.js";

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
    note: "A dispatch starts the agent when its type, normalized, is the `agent` (`matched by type`). A dispatch of no type, or of `general-purpose`, starts it when the first line `name: <x>` anywhere in its brief names the agent (that line alone decides: the dispatch is then only <x>), or, when the brief has no `name:` line, when the agent name is a whole word in the first `briefWindow` (default 400) characters (`matched by inlined definition`); the bare-name rule does not read meaning, so a negated mention such as `do not act like the research-synthesizer` also counts; a dispatch with a type of its own is judged by the type alone. The brief is the dispatch's `prompt` text, then its `description`. A dispatch that carries no model does not match `modelMatches`, and the reason says so. `min` defaults to 1, and to 0 when `max` is 0. Needs a harness with `subagents`.",
    needs: () => ["subagents"],
    validate: checkBounds,
    rule: (check, outcome) => dispatched(check, outcome.toolCalls),
  },
} satisfies Record<string, Spec>;
