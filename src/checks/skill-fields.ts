import { REAL_VIAS, SKILL_VIAS } from "../skill-events.js";
import { UsageError } from "../scope.js";
import type { FieldDef, FieldParser } from "./fields.js";

/**
 * Reads a `via`: one mechanism, or a non-empty list of them.
 * @param value - The parsed value.
 * @param at - Where it is, and what it is.
 * @returns The value, unchanged.
 * @throws {UsageError} When it is not one of the field's allowed words, or a non-empty list of them.
 */
export const parseVias: FieldParser = (value, at) => {
  const given: unknown[] = Array.isArray(value) ? value : [value];
  const allowed = at.def.values ?? [];
  if (
    given.length === 0 ||
    !given.every((one) => typeof one === "string" && allowed.includes(one))
  ) {
    throw new UsageError(
      `${at.where}: "${at.name}" must be one of ${allowed.join(", ")}, or a list of them`,
    );
  }
  return value;
};

// The fields of the checks of how a skill reached the agent, in the order the docs list them.
export const SKILL_FIELDS: Record<string, FieldDef> = {
  via: {
    type: "vias",
    values: SKILL_VIAS,
    expected: "a mechanism, or a list of them",
    meaning:
      'How the skill reached the agent: `"skill_tool"` (a call of the harness\'s skill tool), `"file_read"` (a read-kind call of a file in the skill\'s directory), `"shell_read"` (a shell command that `cat`s, `head`s, `tail`s, `less`es, `bat`s, `nl`s or `sed -n`s such a file), or a list of them. `"injected"` is reserved: nothing produces it yet.',
    default: { value: { "*": REAL_VIAS }, note: "the three real mechanisms" },
  },
  resolved: {
    type: "bool",
    meaning:
      "For `skill_loaded` and `skill_not_loaded`: true counts only a load of a skill of the loaded subject, so a run with no subject that calls the skill tool with a name does not count; false counts only the loads that are not. Default: both count.",
  },
};
