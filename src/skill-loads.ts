import type { ToolCall } from "./harnesses/shared.js";

/** One call that counts as the agent loading a skill. */
export interface SkillLoad {
  /** The skill's name, without any plugin prefix. */
  skill: string;
  /** The call's position in the run's list. */
  index: number;
}

const SKILL_FILE = /skills[\\/]+([\w-]+)[\\/]+skill\.md/gi;

/**
 * Applies the one rule for "the agent loaded a skill", shared by every harness.
 * @param toolCalls - Every tool call of a run.
 * @returns One event for each skill a call loads, in the order of the calls: a call of the harness's skill tool that
 *   names the skill (any `plugin:` prefix dropped), and a call of any tool whose input points at
 *   `skills/<name>/SKILL.md`. Its `index` is the call's own `index`, or its position when the call has none.
 */
export function skillLoads(toolCalls: ToolCall[]): SkillLoad[] {
  return toolCalls.flatMap(({ kind, input, index: own }, position) => {
    const index = own ?? position;
    const names: string[] = [];
    if (kind === "skill") {
      // Object() turns an input that is no object into one with none of the three keys.
      const given = Object(input) as Record<string, unknown>;
      const named = [given["skill"], given["name"], given["id"]].find(
        (value) => typeof value === "string",
      );
      if (named) names.push(named.slice(named.lastIndexOf(":") + 1));
    }
    for (const match of JSON.stringify(input ?? null).matchAll(SKILL_FILE)) {
      names.push(String(match[1]));
    }
    return names.map((skill) => ({ skill, index }));
  });
}

/**
 * Lists the skills the agent loaded.
 * @param toolCalls - Every tool call of a run.
 * @returns The sorted, distinct names of the skills in `skillLoads`.
 */
export const skillsLoaded = (toolCalls: ToolCall[]): string[] =>
  [...new Set(skillLoads(toolCalls).map(({ skill }) => skill))].sort();
