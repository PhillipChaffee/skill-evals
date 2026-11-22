import type { FieldDef } from "./fields.js";

// The fields that say what a harness must be able to do, in the order the docs list them.
export const NEED_FIELDS: Record<string, FieldDef> = {
  requires: {
    type: "needs",
    meaning:
      'A list of capabilities the check needs, such as `"mcp"`, or `"bin:<name>"` for an executable on the host\'s `PATH`. A harness that lacks one cannot run the check.',
  },
  ifUnsupported: {
    type: "enum",
    values: ["skip", "not-applicable"],
    meaning:
      'What a harness that lacks what the check needs does: "skip" drops this check and re-normalizes the weights, "not-applicable" excludes the whole case. Default: "not-applicable".',
  },
};
