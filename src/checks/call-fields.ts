import { DEFAULT_WINDOW } from "../dispatch-rule.js";
import { minOf } from "./min-of.js";
import type { FieldDef } from "./fields.js";
import { SKILL_FIELDS } from "./skill-fields.js";

// The skill fields and their parser belong to skill-fields.ts; fields.ts reads them through this table of fields.
export { parseVias } from "./skill-fields.js";
export { parseBy } from "../agents.js";

// The key that `before` and `after` take besides the matcher keys.
const WHICH: Record<string, FieldDef> = {
  which: {
    type: "enum",
    values: ["first", "last"],
    meaning: 'Which matching call counts: "first" or "last".',
    default: { value: { "*": "first" } },
  },
};

// The fields of the checks that count, order and pick tool calls, in the order the docs list them.
export const CALL_FIELDS: Record<string, FieldDef> = {
  inputLinesMax: {
    type: "int",
    meaning:
      "The most lines that the call's input may have, counted in its longest string value, found at any depth. A call with no string value has none.",
  },
  inputLinesMin: {
    type: "int",
    meaning:
      "The fewest lines that the call's input must have, counted in the same way as `inputLinesMax`. `inputLinesMin: 1001` fits a call with a value of more than 1000 lines, so `tool_not_called` with it says that no single write was that long.",
  },
  minDurationMs: {
    type: "int",
    meaning:
      "The fewest milliseconds that the call took, as its tool result says. A call whose duration is unknown does not fit. Needs a harness with `toolDurations`; elsewhere the case is not applicable.",
  },
  maxDurationMs: {
    type: "int",
    meaning:
      "The most milliseconds that the call took, as its tool result says. A call whose duration is unknown does not fit. Needs a harness with `toolDurations`.",
  },
  by: {
    type: "by",
    meaning:
      'Whose calls, skill loads or text count: `"main"` (the main thread), `"subagent"` (any subagent, at any depth), or `{ "agent": "<name>" }` (agents of that type; a plugin prefix is dropped, so `magic:comment-sicko:comment-sicko` and `comment-sicko` are the same). Absent: every agent. Needs a harness with `childCalls`; on `transcript_matches` and `transcript_lacks`, `childText`.',
  },
  agent: {
    type: "text",
    meaning:
      "The agent type a dispatch must name, with or without a plugin prefix (`magic:comment-sicko:comment-sicko` and `comment-sicko` are the same).",
  },
  dispatches: {
    type: "text",
    meaning:
      "An agent name: matches the `subagent` calls that start that agent, by the rule of `agent_dispatched` (the dispatch's type with any plugin prefix dropped, or for a generic dispatch the first `name: <agent>` line in its brief, or with no such line the name as a whole word in its first 400 characters). Needs a harness with `subagents`.",
  },
  briefMatches: {
    type: "regex",
    meaning:
      "A regular expression for the dispatch's brief: its `prompt` text, then its `description` text. A dispatch whose brief does not match does not count.",
  },
  briefWindow: {
    type: "int",
    meaning:
      "How many characters of the brief the bare agent name may appear in, for a dispatch that names no agent type or `general-purpose`. The first `name: <x>` line anywhere in the brief decides the agent alone; the bare name is looked for only without one.",
    default: { value: { "*": DEFAULT_WINDOW } },
  },
  modelMatches: {
    type: "regex",
    meaning:
      "A regular expression for the model a dispatch chose. A dispatch that carries no model does not match.",
  },
  anyOf: {
    type: "texts",
    meaning:
      "A list of skill names, any of which is accepted. Give this or `skill`, not both.",
  },
  min: {
    type: "count",
    meaning:
      "The fewest that pass, a whole number, 0 or more: matching calls for `tool_called`, matching questions for `asked_user`, matching dispatches for `agent_dispatched`, matching files for `file_count`, lines for `file_lines`, hooks of the event for `hook_fired`.",
    default: {
      value: {
        tool_called: minOf,
        agent_dispatched: minOf,
        asked_user: minOf,
        file_count: 1,
        hook_fired: minOf,
      },
      note: "0 for `tool_called`, `agent_dispatched`, `asked_user` and `hook_fired` when `max` is 0",
    },
  },
  max: {
    type: "count",
    meaning:
      "The most that pass, a whole number, 0 or more: matching calls for `tool_called`, matching questions for `asked_user`, matching dispatches for `agent_dispatched`, matching files for `file_count`, lines for `file_lines`, hooks of the event for `hook_fired`. Default: no limit.",
  },
  sameTurn: {
    type: "bool",
    meaning:
      "True to require every matching call to be issued in one assistant turn, so that `min` and `max` count calls that were launched together. A matching call with no turn fails it, unless it is the only match. Needs a harness with `turnGrouping`.",
    default: { value: { "*": false } },
  },
  first: {
    type: "bool",
    meaning:
      "True to require the first thing the agent did to be what the check names: for `tool_called`, the run's first tool call fits the matcher fields, or with `by`, the first call made by that agent does; for `skill_loaded`, the first skill load is the skill, and no tool call outside `ignoring` comes before it.",
    default: { value: { "*": false } },
  },
  before: {
    type: "matcher",
    extras: WHICH,
    meaning:
      "The calls that must come first, as a matcher, with `which` for the first or last of them. Every call counts, a subagent's included, unless the matcher says `by`.",
  },
  after: {
    type: "matcher",
    extras: WHICH,
    meaning:
      "The calls that must come second, as a matcher, with `which` for the first or last of them. Every call counts, a subagent's included, unless the matcher says `by`.",
  },
  sequence: {
    type: "matchers",
    meaning:
      "A list of matchers that must match calls in this order, with other calls allowed between them.",
  },
  strict: {
    type: "bool",
    meaning:
      "True for a `sequence` to forbid a later matcher's call before an earlier matcher's first match, and an earlier matcher's call after a later matcher's first match.",
    default: { value: { "*": false } },
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
  ...SKILL_FIELDS,
};
