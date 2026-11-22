import type { FieldDef } from "./fields.js";

/** Where `context_injected` looks for the text. */
const SOURCES = ["hooks", "rules", "any"] as const;
/** One place `context_injected` looks. */
export type Source = (typeof SOURCES)[number];

// The fields of the checks of hooks and injected context, in the order the docs list them.
export const HOOK_FIELDS: Record<string, FieldDef> = {
  event: {
    type: "text",
    meaning:
      'The event of a hook, written as the harness names it, such as `"SessionStart"`. The match is exact and case-sensitive.',
  },
  source: {
    type: "enum",
    values: SOURCES,
    meaning:
      'Where `context_injected` looks: "hooks" (the context that hooks put in front of the model), "rules" (the rule and instruction text that the harness reports it loaded), or "any" of them. The files the run installed are never read: only what the harness reports counts.',
    default: { value: { "*": "any" } },
  },
};
