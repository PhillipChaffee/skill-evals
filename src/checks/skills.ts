import { fitsBy } from "../agents.js";
import { globToRegExp } from "../glob.js";
import { firstOutside, quoteCalls } from "../matchers.js";
import { UsageError } from "../scope.js";
import type { SkillLoad, SkillVia } from "../skill-events.js";
import { REAL_VIAS, legacySkillLoads } from "../skill-events.js";
import type { Outcome, RuledCheck, Spec, Verdict } from "./index.js";
import { byNeeds, unseenAgent } from "./by-needs.js";
import { PASS } from "./rules.js";

const positions = (loads: SkillLoad[]): number[] =>
  loads.map(({ index }) => index);
const list = (words: string[]): string => words.join(", ");

// The skills a check names.
const namedBy = (check: RuledCheck): string[] =>
  check.anyOf ?? (check.skill === undefined ? [] : [check.skill]);

// The mechanisms a check accepts.
const viasOf = (check: RuledCheck): readonly SkillVia[] =>
  check.via === undefined ? REAL_VIAS : [check.via].flat();

/**
 * Finds the loads a check counts, in the order of the calls.
 * @param check - A `skill_loaded` or `skill_not_loaded` check.
 * @param outcome - What the run left behind.
 * @returns Under `--lenient`, and with neither `via` nor `resolved`, the loads of the 0.0.1 rule: any input that
 *   mentions `skills/<name>/SKILL.md`. Otherwise the `load` events of the run, of the check's `via` and, with
 *   `resolved`, of that kind. With `by`, only the loads made by those agents.
 */
function loadsOf(check: RuledCheck, outcome: Outcome): SkillLoad[] {
  if (
    outcome.legacySkillLoads &&
    check.via === undefined &&
    check.resolved === undefined
  ) {
    return legacySkillLoads(outcome.toolCalls).filter(({ agent }) =>
      fitsBy(check.by, agent),
    );
  }
  const vias = viasOf(check);
  return outcome.skillEvents.filter(
    (event) =>
      event.type === "load" &&
      fitsBy(check.by, event.agent) &&
      vias.includes(event.via) &&
      (check.resolved === undefined || event.resolved === check.resolved),
  );
}

const loadedNames = (loads: SkillLoad[]): string =>
  list([...new Set(loads.map(({ skill }) => skill))].sort()) || "none";

/**
 * Scores `first`: the first skill load is a named skill, and no call outside `ignoring` comes before it. With `by`,
 * both are about that agent: its first load, and the calls it made before it.
 * @param check - A `skill_loaded` check with `first` set.
 * @param outcome - What the run left behind.
 * @returns 1 when both hold, and the reason one does not.
 */
function loadedFirst(check: RuledCheck, outcome: Outcome): Verdict {
  const all = outcome.toolCalls;
  const [first] = loadsOf(check, outcome);
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
  const earlier = all
    .slice(0, first.index)
    .map((call, position) => ({ call, position }))
    .filter(({ call }) => fitsBy(check.by, call.agent));
  const found = firstOutside(
    earlier.map(({ call }) => call),
    check.ignoring ?? [],
  );
  const before = earlier[found]?.position ?? -1;
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
  const loads = loadsOf(check, outcome);
  if (loads.some(({ skill }) => names.includes(skill))) return PASS;
  const what =
    check.anyOf === undefined
      ? `"${list(names)}" was not loaded`
      : `none of ${list(names)} was loaded`;
  return {
    score: 0,
    reason: `${what} (loaded: ${loadedNames(loads)})\n${quoteCalls(outcome.toolCalls, positions(loads))}`,
  };
}

/**
 * Scores a `skill_not_loaded` check.
 * @param check - A `skill_not_loaded` check.
 * @param outcome - What the run left behind.
 * @returns 1 when no counted load names the skill, and the call of the first one otherwise. With `by` naming an agent
 *   that never ran, 0.
 */
function skillNotLoaded(check: RuledCheck, outcome: Outcome): Verdict {
  const unseen = unseenAgent(check, outcome);
  if (unseen) return unseen;
  const loads = loadsOf(check, outcome).filter(
    ({ skill }) => skill === check.skill,
  );
  if (loads.length === 0) return PASS;
  return {
    score: 0,
    reason: `"${String(check.skill)}" was loaded (call #${String(loads[0]?.index)})\n${quoteCalls(outcome.toolCalls, positions(loads))}`,
  };
}

/**
 * Scores a `skill_file_read` check.
 * @param check - A `skill_file_read` check.
 * @param outcome - What the run left behind.
 * @returns 1 when the agent read a file of the skill that the glob `path` matches, relative to the skill's directory.
 */
function skillFileRead(check: RuledCheck, outcome: Outcome): Verdict {
  const vias = viasOf(check);
  const glob = globToRegExp(check.path ?? "");
  const reads = outcome.skillEvents.filter(
    (event) =>
      event.type === "file_read" &&
      event.skill === check.skill &&
      vias.includes(event.via),
  );
  if (reads.some(({ file }) => glob.test(file ?? ""))) return PASS;
  const seen = list(reads.map(({ file }) => String(file))) || "none";
  return {
    score: 0,
    reason: `no file of "${String(check.skill)}" matching ${String(check.path)} was read (read: ${seen})\n${quoteCalls(outcome.toolCalls, positions(reads))}`,
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

/**
 * Fails a listing check when the harness reported no skills, which proves neither that a skill is there nor that it is not.
 * @param outcome - What the run left behind.
 * @returns A score of 0 with the reason when `loaded.skills` is null; undefined when the listing is known.
 */
const listing = (outcome: Outcome): Verdict | undefined =>
  outcome.loaded.skills === null
    ? { score: 0, reason: "the harness did not report its skills" }
    : undefined;

const LISTING_NOTE =
  "It reads the skills the harness reported at startup, so it needs the capability `skillListing`; a harness without it makes the case not applicable, and a run whose harness reported no skills scores 0.";

// The checks of which skills the agent loaded.
export const SKILL_CHECKS = {
  skill_loaded: {
    fields: [],
    forms: [["skill"], ["anyOf"]],
    together: { ignoring: ["first"] },
    optional: ["skill", "anyOf", "first", "ignoring", "via", "resolved", "by"],
    needs: byNeeds,
    scores:
      "The agent loaded that skill, or any of the skills in `anyOf`, through the skill tool, a read of its `SKILL.md`, or a shell command that reads it.",
    note: "A load is a real one: a skill-kind call that names the skill, or a read-kind or `cat`-style shell call of `SKILL.md` in the loaded subject's own copy of the skill. A `grep`, a listing, and a path in the workspace that merely looks like `skills/<name>/SKILL.md` are not loads. With `first: true` the first skill load must be a named skill, and no tool call that does not fit `ignoring` may come before it; every call of the run counts, a subagent's included, unless `by` limits both the loads and the calls to one agent. It takes exactly one of `skill` and `anyOf`, and `ignoring` only with `first`. Under `--lenient`, a check with neither `via` nor `resolved` keeps the 0.0.1 rule for one release: any tool input that mentions `skills/<name>/SKILL.md`, in any case.",
    validate: checkSkillFields,
    rule: skillLoaded,
  },
  skill_not_loaded: {
    fields: ["skill"],
    optional: ["via", "resolved", "by"],
    needs: byNeeds,
    scores: "The agent did not load that skill.",
    note: "It counts loads as `skill_loaded` does, including `via`, `resolved` and `by`, and keeps the 0.0.1 rule under `--lenient` in the same way.",
    rule: skillNotLoaded,
  },
  skill_available: {
    fields: ["skill"],
    scores: "The harness listed that skill among the skills it loaded.",
    note: LISTING_NOTE,
    needs: () => ["skillListing"],
    rule: (check, outcome) =>
      listing(outcome) ??
      (outcome.loaded.skills?.includes(String(check.skill))
        ? PASS
        : {
            score: 0,
            reason: `"${String(check.skill)}" is not in the harness's listing (listed: ${list(outcome.loaded.skills ?? []) || "none"})`,
          }),
  },
  skill_not_available: {
    fields: ["skill"],
    scores: "The harness did not list that skill among the skills it loaded.",
    note: LISTING_NOTE,
    needs: () => ["skillListing"],
    rule: (check, outcome) =>
      listing(outcome) ??
      (outcome.loaded.skills?.includes(String(check.skill))
        ? {
            score: 0,
            reason: `"${String(check.skill)}" is in the harness's listing`,
          }
        : PASS),
  },
  skill_file_read: {
    fields: ["skill", "path"],
    optional: ["via"],
    scores:
      "The agent read a file of that skill's directory other than `SKILL.md`, whose path relative to the directory matches the glob `path`.",
    note: "Reads count through a read-kind call or a `cat`-style shell command, as for `skill_loaded`; `path` is relative to the skill's directory, not to the workspace, and may be a glob such as `references/*.md`.",
    rule: skillFileRead,
  },
} satisfies Record<string, Spec>;
