import type { ToolMatcher } from "../matchers.js";
import { matches, quoteCalls } from "../matchers.js";
import { UsageError } from "../scope.js";
import type { SkillLoad } from "../skill-loads.js";
import { skillLoads } from "../skill-loads.js";
import type { Outcome, RuledCheck, Spec, Verdict } from "./index.js";

const PASS: Verdict = { score: 1 };
const positions = (loads: SkillLoad[]): number[] =>
  loads.map(({ index }) => index);
const list = (words: string[]): string => words.join(", ");

// The skills a check names.
const namedBy = (check: RuledCheck): string[] =>
  check.anyOf ?? (check.skill === undefined ? [] : [check.skill]);

/**
 * Scores `first`: the first skill load is a named skill, and no call outside `ignoring` comes before it.
 * @param check - A `skill_loaded` check with `first` set.
 * @param outcome - What the run left behind.
 * @returns 1 when both hold, and the reason one does not.
 */
function loadedFirst(check: RuledCheck, outcome: Outcome): Verdict {
  const all = outcome.toolCalls;
  const [first] = skillLoads(all);
  if (!first) {
    return { score: 0, reason: `no skill was loaded\n${quoteCalls(all, [])}` };
  }
  const names = namedBy(check);
  if (!names.includes(first.skill)) {
    return {
      score: 0,
      reason: `the first skill load is "${first.skill}" (call #${String(first.index)}), not ${names.length === 1 ? `"${list(names)}"` : `one of ${list(names)}`}\n${quoteCalls(all, [first.index])}`,
    };
  }
  const ignoring: ToolMatcher[] = check.ignoring ?? [];
  const before = all
    .slice(0, first.index)
    .findIndex((call) => !ignoring.some((one) => matches(one, call)));
  if (before < 0) return PASS;
  return {
    score: 0,
    reason: `call #${String(before)} comes before the first skill load (call #${String(first.index)})\n${quoteCalls(all, [before, first.index])}`,
  };
}

/**
 * Scores a `skill_loaded` check.
 * @param check - A `skill_loaded` check.
 * @param outcome - What the run left behind.
 * @returns With `first`, `loadedFirst`; otherwise 1 when any named skill is among the loaded ones.
 */
function skillLoaded(check: RuledCheck, outcome: Outcome): Verdict {
  if (check.first) return loadedFirst(check, outcome);
  const names = namedBy(check);
  if (names.some((name) => outcome.skillsLoaded.includes(name))) return PASS;
  const loads = skillLoads(outcome.toolCalls);
  const what =
    check.anyOf === undefined
      ? `"${list(names)}" was not loaded`
      : `none of ${list(names)} was loaded`;
  const loaded = list(outcome.skillsLoaded) || "none";
  return {
    score: 0,
    reason: `${what} (loaded: ${loaded})\n${quoteCalls(outcome.toolCalls, positions(loads))}`,
  };
}

/**
 * Checks the fields of `skill_loaded` together.
 * @param given - The fields that are set.
 * @param where - Names the file and the check in an error message.
 * @throws {UsageError} When both `skill` and `anyOf` are given, or `ignoring` is given without `first`.
 */
function checkSkillFields(given: Record<string, unknown>, where: string): void {
  if (!("skill" in given || "anyOf" in given)) {
    throw new UsageError(
      `${where}: skill_loaded needs a string "skill" or a list "anyOf"`,
    );
  }
  if ("skill" in given && "anyOf" in given) {
    throw new UsageError(
      `${where}: skill_loaded takes exactly one of "skill" and "anyOf"`,
    );
  }
  if ("ignoring" in given && given["first"] !== true) {
    throw new UsageError(`${where}: "ignoring" only applies with "first"`);
  }
}

// The checks of which skills the agent loaded.
export const SKILL_CHECKS = {
  skill_loaded: {
    fields: [],
    forms: [["skill"], ["anyOf"]],
    optional: ["skill", "anyOf", "first", "ignoring"],
    scores: "The agent loaded that skill, or any of the skills in `anyOf`.",
    note: "With `first: true` the first skill load must be a named skill, and no tool call that does not fit `ignoring` may come before it; every call of the run counts, a subagent's included, because calls cannot yet be told apart by the agent that made them. It takes exactly one of `skill` and `anyOf`, and `ignoring` only with `first`.",
    validate: checkSkillFields,
    rule: skillLoaded,
  },
  skill_not_loaded: {
    fields: ["skill"],
    scores: "The agent did not load that skill.",
    rule: (check, outcome) => {
      if (!outcome.skillsLoaded.includes(check.skill as string)) return PASS;
      const loads = skillLoads(outcome.toolCalls).filter(
        ({ skill }) => skill === check.skill,
      );
      return {
        score: 0,
        reason: `"${String(check.skill)}" was loaded (call #${String(loads[0]?.index)})\n${quoteCalls(outcome.toolCalls, positions(loads))}`,
      };
    },
  },
} satisfies Record<string, Spec>;
