import type { FieldDef } from "./fields.js";

// The key that `before` and `after` take besides the matcher keys.
const WHICH: Record<string, FieldDef> = {
  which: {
    type: "enum",
    values: ["first", "last"],
    meaning: 'Which matching call counts: "first" or "last". Default: "first".',
  },
};

// The fields of the checks that count, order and pick tool calls, in the order the docs list them.
export const CALL_FIELDS: Record<string, FieldDef> = {
  anyOf: {
    type: "texts",
    meaning:
      "A list of skill names, any of which is accepted. Give this or `skill`, not both.",
  },
  min: {
    type: "count",
    meaning:
      "The fewest matching calls that pass: a whole number, 0 or more. Default: 1.",
  },
  max: {
    type: "count",
    meaning:
      "The most matching calls that pass: a whole number, 0 or more. Default: no limit.",
  },
  sameTurn: {
    type: "bool",
    meaning:
      "True to require every matching call to be issued in one assistant turn, so that `min` and `max` count calls that were launched together. A matching call with no turn fails it, unless it is the only match. Needs a harness with `turnGrouping`. Default: false.",
  },
  first: {
    type: "bool",
    meaning:
      "True to require the first thing the agent did to be what the check names: for `tool_called`, the run's first tool call fits the matcher fields; for `skill_loaded`, the first skill load is the skill, and no tool call outside `ignoring` comes before it. Default: false.",
  },
  before: {
    type: "matcher",
    extras: WHICH,
    meaning:
      "The calls that must come first, as a matcher, with `which` for the first or last of them. Every call counts, a subagent's included.",
  },
  after: {
    type: "matcher",
    extras: WHICH,
    meaning:
      "The calls that must come second, as a matcher, with `which` for the first or last of them. Every call counts, a subagent's included.",
  },
  sequence: {
    type: "matchers",
    meaning:
      "A list of matchers that must match calls in this order, with other calls allowed between them.",
  },
  strict: {
    type: "bool",
    meaning:
      "True for a `sequence` to forbid a later matcher's call before an earlier matcher's first match, and an earlier matcher's call after a later matcher's first match. Default: false.",
  },
  matches: {
    type: "matcher",
    meaning: "The matcher that the first tool call must fit.",
  },
  ignoring: {
    type: "matchers",
    meaning:
      "Matchers for calls to leave out before looking at the first call, such as a read the agent is allowed to make first.",
  },
};
