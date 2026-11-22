import { SKILL_VIAS } from "../skill-events.js";
import type { FieldDef } from "./fields.js";

// The fields of the checks of how a skill reached the agent, in the order the docs list them.
export const SKILL_FIELDS: Record<string, FieldDef> = {
  via: {
    type: "vias",
    values: SKILL_VIAS,
    expected: "a mechanism, or a list of them",
    meaning:
      'How the skill reached the agent: `"skill_tool"` (a call of the harness\'s skill tool), `"file_read"` (a read-kind call of a file in the skill\'s directory), `"shell_read"` (a shell command that `cat`s, `head`s, `tail`s, `less`es, `bat`s, `nl`s or `sed -n`s such a file), or a list of them. `"injected"` is reserved: nothing produces it yet. Default: the three real mechanisms.',
  },
  resolved: {
    type: "bool",
    meaning:
      "For `skill_loaded` and `skill_not_loaded`: true counts only a load of a skill of the loaded subject, so a run with no subject that calls the skill tool with a name does not count; false counts only the loads that are not. Default: both count.",
  },
};
