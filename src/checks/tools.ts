import { fails, holds, regex } from "./fields.js";
import type { Spec, Test } from "./index.js";

const TOOL_FIELDS = {
  optional: ["kind", "name", "inputMatches", "flags"],
  oneOf: ["kind", "name"],
} satisfies Partial<Spec>;

const toolCalled: Test<never> = (check, outcome) =>
  outcome.toolCalls.some(
    (call) =>
      (check.kind === undefined || call.kind === check.kind) &&
      (check.name === undefined ||
        regex(check.name, check.flags).test(call.name)) &&
      (check.inputMatches === undefined ||
        regex(check.inputMatches, check.flags).test(
          JSON.stringify(call.input ?? null),
        )),
  );

// The checks of the tool calls the agent made.
export const TOOL_CHECKS = {
  tool_called: holds([], toolCalled, {
    ...TOOL_FIELDS,
    scores: "The agent made a tool call that fits every given field.",
  }),
  tool_not_called: fails([], toolCalled, {
    ...TOOL_FIELDS,
    scores: "The agent made no tool call that fits every given field.",
  }),
};
