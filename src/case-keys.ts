import type { FieldDef } from "./checks/fields.js";
import { WEIGHT } from "./checks/fields.js";
import { LAYER_KEYS } from "./case-layers.js";
import { LIMIT_KEYS } from "./case-limits.js";

// The top-level keys of a case file. Any other key is a load error, unless it starts with `x-`.
export const CASE_KEYS: Record<string, FieldDef> = {
  checks: {
    type: "object",
    meaning:
      "A non-empty list of checks. A case with `turns` may leave it out when a turn has checks.",
  },
  weight: {
    ...WEIGHT,
    meaning: "How much the case counts in its suite. Default: 1.",
  },
  minScore: {
    type: "unit",
    meaning: "The lowest score the case may get and still pass.",
  },
  ...LIMIT_KEYS,
  requires: {
    type: "needs",
    meaning:
      'A list of capabilities the case needs, such as `"mcp"`, or `"bin:<name>"` for an executable on the host\'s `PATH`. A harness that lacks one reports the case as not applicable.',
  },
  harnesses: {
    type: "harnesses",
    meaning:
      "The harness ids the case is for. Any other harness reports it as not applicable. Needs `note`. A last resort: prefer `requires`.",
  },
  note: {
    type: "text",
    meaning: "Why the case is limited to `harnesses`. The report shows it.",
  },
  tags: {
    type: "tags",
    meaning:
      "Labels for selecting cases with `--tag`, `--tag-all` and `--not-tag`. Each is lowercase letters, digits and hyphens.",
  },
  description: { type: "text", meaning: "What the case shows, in a sentence." },
  targets: {
    type: "texts",
    meaning:
      "The names of the skills the case is about. The report counts the cases of each in its coverage table.",
  },
  kind: {
    type: "text",
    meaning: "The kind of case, such as `trigger` or `negative`.",
  },
  expected: {
    type: "text",
    meaning:
      "What a good run does, in a sentence. It is for readers; no check reads it.",
  },
  guard: {
    type: "bool",
    meaning:
      "True for a case that must keep passing. The report lists it in its own table. Its score counts in the suite score like any other. Default: false.",
  },
  reps: {
    type: "int",
    meaning: "Runs for each subject in this case, in place of `--reps`.",
  },
  model: {
    type: "text",
    meaning: "The model of the agent in this case, in place of `--model`.",
  },
  judgeModel: {
    type: "text",
    meaning:
      "The model that scores the judged checks of this case, in place of `--judge-model`.",
  },
  env: {
    type: "envvars",
    meaning:
      "Variables the agent's process gets, with the values given here. A name starts with `CASE_`, or is `TZ`, `LANG` or `LC_ALL`.",
  },
  minDelta: {
    type: "signed",
    meaning:
      "The least score difference, B minus A, that the case must show. A number from -1 to 1; a negative number lets B score lower by at most that much.",
  },
  ...LAYER_KEYS,
  turns: {
    type: "turns",
    meaning:
      "A non-empty list of turns, in place of `prompt.md`: each is a user message (`prompt`, a file of the case), a user invocation of a skill (`invoke`) or a lifecycle event (`event`), with optional `checks` that look at that turn only. One harness process runs each turn, and each continues the session of the one before. A case has `prompt.md` or `turns`, not both. See the turn keys below.",
  },
  variants: {
    type: "variants",
    meaning:
      "A non-empty list of variants: the same case put differently, such as a paraphrase or a pressure. Each runs as `<case id>@<variant id>`, and the case never runs bare. See the variant keys below.",
  },
};
