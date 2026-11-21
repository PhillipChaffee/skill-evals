import { fails, holds, regex } from "./rules.js";
import type { Spec, Test } from "./index.js";

const FLAGS = { optional: ["flags"] } satisfies Partial<Spec>;
const outputMatches: Test<"pattern"> = (check, outcome) =>
  regex(check.pattern, check.flags).test(outcome.finalText);
const outputContains: Test<"text"> = (check, outcome) =>
  outcome.finalText.includes(check.text);

// The checks of the final answer.
export const OUTPUT_CHECKS = {
  output_matches: holds(["pattern"], outputMatches, {
    ...FLAGS,
    scores: "The final answer matches the regular expression.",
  }),
  output_lacks: fails(["pattern"], outputMatches, {
    ...FLAGS,
    scores: "The final answer does not match the regular expression.",
  }),
  output_contains: holds(["text"], outputContains, {
    scores: "The final answer contains that text.",
  }),
  output_not_contains: fails(["text"], outputContains, {
    scores: "The final answer does not contain that text.",
  }),
};
