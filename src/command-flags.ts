import type { Flag } from "./flags.js";

/** The flags of the commands that run a suite: `run`, `score`, `plan` and `calibrate`. */
export const SUITE_FLAGS: Flag[] = [
  "harness",
  "case",
  "not-case",
  "tag",
  "tag-all",
  "not-tag",
  "heldout",
  "cases",
  "reps",
  "jobs",
  "retries",
  "max-cost",
  "max-duration",
  "model",
  "min-score",
  "max-invalid",
  "report",
  "judge-harness",
  "judge-model",
  "judge-api",
  "judge-url",
  "decision-model",
  "decision-url",
  "decision-timeout",
  "lenient",
  "isolated",
  "history-mode",
  "keep-workspaces",
  "out",
  "resume",
  "dry-run",
];

/** The flags that only a comparison of subjects uses. */
export const COMPARE_FLAGS: Flag[] = ["min-delta", "noise", "seed"];
