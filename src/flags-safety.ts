/** The flags that bound what a run may do and ask before it does it. `FLAGS` checks them against `FlagSpec`. */
export const SAFETY_FLAGS = {
  sandbox: {
    kind: "switch" as const,
    value: "",
    description:
      'Run each harness process in an OS sandbox: bwrap on Linux, sandbox-exec on macOS. The workspace, the throwaway home and the run\'s own temp directory are writable and everything else is read-only; a case with `network: "off"` gets no network. Setup steps and `command` checks run outside it. It exits 2 when no backend is installed. A case with `network: "off"` or `"provider-only"` is not applicable without it, and `provider-only` is not applicable with it.',
    default: "off: the harness runs as you",
  },
  yes: {
    kind: "switch" as const,
    value: "",
    description:
      'Run a cases directory that has not been approved, without asking. On a terminal skill-evals asks "run these N cases? [y/N]" about a directory whose path and content it has not seen, and remembers the answer; without a terminal it exits 2 unless this is given. It does not remember a --yes.',
    default: "off: ask on a terminal, refuse without one",
  },
  "show-prompts": {
    as: "showPrompts" as const,
    kind: "switch" as const,
    value: "",
    description:
      "Print every prompt of each selected case: each turn, and whether a history preamble is added in front of the first.",
    default: "off",
  },
};
