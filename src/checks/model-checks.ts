import { checkModelFields } from "./judge-fields.js";
import type { Spec } from "./index.js";

// The check types that a model scores. Their rules live in judge.ts and decision.ts.
export const MODEL_CHECKS: Record<string, Spec> = {
  judge: {
    fields: ["rubric"],
    optional: ["scale", "votes", "sees", "files", "maxChars"],
    scores:
      "A model scores what it sees against the rubric: a pass or fail with `scale` binary, else not 0 or 1.",
    note: "It sees the final answer unless `sees` says more. With `votes` it is asked more than once.",
    together: { files: ["sees"], maxChars: ["sees"] },
    validate: checkModelFields,
  },
  decision: {
    fields: ["question"],
    optional: ["expect", "options", "sees", "files", "maxChars"],
    scores:
      "Not 0 or 1. A decision model gives each allowed answer a probability, and the score is the expected value. Experimental: it has not been run against the hosted endpoint.",
    note: "It takes exactly one of `expect` and `options`.",
    together: { files: ["sees"], maxChars: ["sees"] },
    validate: checkModelFields,
  },
};
