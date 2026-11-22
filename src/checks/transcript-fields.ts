import type { FieldDef } from "./fields.js";

/** What the text of a check is taken from: the assistant's text, a call's input, a tool's output, or all three. */
const WHERE_VALUES = [
  "assistant_text",
  "tool_input",
  "tool_output",
  "all",
] as const;
/** What a check tests. */
export type Where = (typeof WHERE_VALUES)[number];

// The fields of the checks of assistant text and tool outputs, in the order the docs list them.
export const TRANSCRIPT_FIELDS: Record<string, FieldDef> = {
  where: {
    type: "enum",
    values: WHERE_VALUES,
    meaning:
      'What the pattern tests: "assistant_text" (the default), "tool_input" (each call\'s input, written as JSON), "tool_output", or "all" of them. Each event\'s text is cut to its first 1,000,000 characters first. `tool_output` and `all` need a harness with `toolOutputs`; `assistant_text` needs `assistantText`.',
  },
  scope: {
    type: "scope",
    meaning:
      'Which events are tested: "any" (the default), "first_message" (the main agent\'s first non-empty text, wherever it falls), "final_message" (its last non-empty text), `{ "before": matcher }` or `{ "after": matcher }` (the events before or after the first call that fits the matcher; no such call scores 0), or `{ "first_message": true, "before": matcher }` (the first text, which scores 0 when it comes after the matcher\'s first call).',
  },
  which: {
    type: "enum",
    values: ["first", "last", "any"],
    meaning:
      'Which of the calls that fit `tool` count: "first", "last", or "any" of them. Default: "any". A chosen call with no output scores 0.',
  },
  tool: {
    type: "matcher",
    meaning:
      "The matcher for the calls whose outputs are tested. For `tool_output_size` it is optional: without it every output counts.",
  },
  maxBytes: {
    type: "int",
    meaning:
      "The most bytes that one tool output may have, as UTF-8 text. A call with no result is ignored.",
  },
};
