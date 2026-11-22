import type { Capability } from "../capabilities.js";
import { tester } from "../matchers.js";
import type { Check, Outcome, Spec, Verdict } from "./index.js";
import { checkBounds, checkOpenMin } from "./bounds.js";
import { minOf, valueOf } from "./defaults.js";
import type { Source } from "./hook-fields.js";
import { PASS } from "./rules.js";

const TEXT_CAP = 1_000_000;
const SHOWN_EVENTS = 8;

/**
 * Lists the hooks that ran.
 * @param outcome - What the run left behind.
 * @returns The hook events of the transcript, in order. A hook event is no tool call, so no tool check counts it.
 */
const hooksOf = (outcome: Outcome) =>
  outcome.transcript.flatMap((one) =>
    one.type === "hook" && one.hook ? [one.hook] : [],
  );

/**
 * Scores `hook_fired`.
 * @param check - The check, whose `event`, `min` and `max` are read.
 * @param outcome - What the run left behind.
 * @returns 1 when the number of hooks of that event is from `min` to `max`.
 */
function hookFired(check: Check, outcome: Outcome): Verdict {
  const event = String(check.event);
  const hooks = hooksOf(outcome);
  const count = hooks.filter((hook) => hook.event === event).length;
  const min = check.min ?? minOf(check);
  const max = check.max ?? Infinity;
  if (count >= min && count <= max) return PASS;
  const seen = [...new Set(hooks.map((hook) => hook.event))];
  const bounds = `${String(min)}${max === Infinity ? " or more" : ` to ${String(max)}`}`;
  return {
    score: 0,
    reason: `${String(count)} ${event} hooks ran, not ${bounds} (hooks that ran: ${seen.slice(0, SHOWN_EVENTS).join(", ") || "none"})`,
  };
}

/**
 * Lists the texts that `context_injected` may read.
 * @param source - Where to look.
 * @param outcome - What the run left behind.
 * @returns The contexts of hooks and the texts of rules the harness reported, as asked; never a file the run installed.
 */
function injectedTexts(source: Source, outcome: Outcome): string[] {
  const fromHooks =
    source === "rules"
      ? []
      : hooksOf(outcome).flatMap((hook) => hook.context ?? []);
  const fromRules = source === "hooks" ? [] : (outcome.loaded.ruleTexts ?? []);
  return [...fromHooks, ...fromRules];
}

/**
 * Scores `context_injected`.
 * @param check - The check, whose `pattern`, `flags` and `source` are read.
 * @param outcome - What the run left behind.
 * @returns 1 when a hook's context, or a rule text that the harness reported, matches the pattern.
 */
function contextInjected(check: Check, outcome: Outcome): Verdict {
  const source = valueOf(check, "source") as Source;
  const texts = injectedTexts(source, outcome);
  const fits = tester(check.pattern, check.flags);
  if (texts.some((text) => fits(text.slice(0, TEXT_CAP)))) return PASS;
  const reports =
    source !== "hooks" && outcome.loaded.ruleTexts == null
      ? "; the harness reports no rule text"
      : "";
  return {
    score: 0,
    reason: `no ${source === "any" ? "hook context or reported rule text" : source === "hooks" ? "hook context" : "reported rule text"} matches /${check.pattern ?? ""}/${check.flags ?? ""} in ${String(texts.length)} tested ${texts.length === 1 ? "text" : "texts"}${reports}`,
  };
}

/**
 * Lists what `context_injected` needs for a source that names one.
 * @param check - A `context_injected` check.
 * @returns `hooks` for the source "hooks", `rulesReport` for "rules"; none for "any", which needs one of them.
 */
function injectedNeeds(check: Check): Capability[] {
  const source = valueOf(check, "source") as Source;
  return source === "rules"
    ? ["rulesReport"]
    : source === "hooks"
      ? ["hooks"]
      : [];
}

/**
 * Lists what `context_injected` needs one of.
 * @param check - A `context_injected` check.
 * @returns `hooks` and `rulesReport` for the source "any"; none otherwise.
 */
const injectedEither = (check: Check): Capability[] =>
  valueOf(check, "source") === "any" ? ["hooks", "rulesReport"] : [];

// The checks of hooks and of the context that reached the model.
export const HOOK_CHECKS = {
  hook_fired: {
    fields: ["event"],
    optional: ["min", "max"],
    precondition: true,
    scores:
      "The number of hooks of that event that ran is from `min` to `max`.",
    note: "`min` is 1, and 0 when `max` is 0. A hook event is never a tool call, so `tool_called` does not count it. Needs a harness with `hooks`.",
    needs: () => ["hooks"],
    validate: (given, where) => {
      checkBounds(given, where);
      checkOpenMin(given, where);
    },
    rule: hookFired,
  },
  context_injected: {
    fields: ["pattern"],
    optional: ["flags", "source"],
    precondition: true,
    scores:
      "A hook's context, or a rule or instruction text that the harness reported it loaded, matches the regular expression.",
    note: 'It never reads the rule files that the run installed itself, which would make the check true of every run. With `source` "hooks" it needs `hooks`, with "rules" it needs `rulesReport` (the harness reports the rule texts it loaded; installing them is the `rules` capability and proves nothing), and with "any", the default, it needs `hooks` or `rulesReport`.',
    needs: injectedNeeds,
    needsAny: injectedEither,
    rule: contextInjected,
  },
} satisfies Record<string, Spec>;
