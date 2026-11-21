import type { Rule } from "./index.js";

const SHOWN_PATHS = 10;

const subjectUnchanged: Rule = (_check, outcome) => {
  const { mutated, observed = true } = outcome.subject;
  if (!observed) {
    return { score: 0, reason: "the subject copy could not be observed" };
  }
  if (mutated.length === 0) return { score: 1 };
  const more = mutated.length - SHOWN_PATHS;
  const shown = mutated.slice(0, SHOWN_PATHS).join(", ");
  return {
    score: 0,
    reason: `changed: ${shown}${more > 0 ? ` and ${String(more)} more` : ""}`,
  };
};

// The checks of what the run left changed outside its workspace.
export const OBSERVED_CHECKS = {
  subject_unchanged: {
    fields: [],
    scores:
      "The agent changed nothing in the copy of the subject that the run loaded.",
    rule: subjectUnchanged,
  },
};
