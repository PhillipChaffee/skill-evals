const PROJECT = "the project, uncommitted changes included";

/** The flags that name the subjects of a command, and the bar subject. `FLAGS` checks them against `FlagSpec`. */
export const SUBJECT_FLAGS = {
  a: { value: "subject", description: "The baseline.", default: "main" },
  b: { value: "subject", description: "The change.", default: PROJECT },
  subjects: {
    value: "name=spec,...",
    description:
      "Two to eight subjects to compare, each as label=spec, in place of --a and --b. The first is the baseline: every other subject gets a delta, interval and verdict against it. A label is lowercase letters, digits and hyphens, starts with a letter, and is unique. A spec is a directory, a git ref or none, and may end in `:` and options that change a copy of it, never the source: hooks=off, rules=on, rules=off, agents=off, agents=except:<glob>, skills=only:<glob>, skills=except:<glob>. Separate options with commas. An existing path that holds a colon is a path, not options. The pass bars apply to the last subject unless --bar-subject says another. A usage error with --a or --b.",
    default: "none: --a and --b name the two subjects",
  },
  "bar-subject": {
    as: "barSubject" as const,
    value: "label",
    description:
      "The label of the subject that --min-score, --min-delta and the cases' bars apply to. A delta bar compares it with the baseline, which is the first subject, so the baseline cannot carry one. A usage error when it is not a label.",
    default: "the last subject",
  },
  subject: {
    value: "subject",
    description:
      "The subject to score, to probe, or to check the skill names of. For show, the label of a subject in the results.",
    default: PROJECT,
    defaultIn: { show: "the first subject of the results" },
  },
};
