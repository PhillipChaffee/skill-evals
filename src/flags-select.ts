/** The flags that choose which cases a command works on. `FLAGS` checks them against `FlagSpec`. */
export const SELECT_FLAGS = {
  case: {
    as: "caseGlob" as const,
    kind: "list" as const,
    value: "globs",
    description:
      "Which case ids to run. A glob: * stays within one directory, ** crosses directories, ? is one character, {a,b} is either. Repeat the flag or separate globs with commas.",
    default: "every case",
  },
  "not-case": {
    as: "notCase" as const,
    kind: "list" as const,
    value: "globs",
    description: "Case ids to leave out, as globs like those of --case.",
    default: "none",
  },
  tag: {
    kind: "list" as const,
    value: "tags",
    description:
      "Run the cases that have any of these tags. Repeat the flag or separate tags with commas.",
    default: "no tag filter",
  },
  "tag-all": {
    as: "tagAll" as const,
    kind: "list" as const,
    value: "tags",
    description: "Run the cases that have all of these tags.",
    default: "no tag filter",
  },
  "not-tag": {
    as: "notTag" as const,
    kind: "list" as const,
    value: "tags",
    description: "Leave out the cases that have any of these tags.",
    default: "none",
  },
  heldout: {
    kind: "switch" as const,
    value: "",
    description:
      "Also run the held-out variants, the ones a case marks with heldout: true. Without it they are left out.",
    default: "off",
  },
};
