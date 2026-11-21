import { fails, holds } from "./rules.js";
import type { Test } from "./index.js";

const skillLoaded: Test<"skill"> = (check, outcome) =>
  outcome.skillsLoaded.includes(check.skill);

// The checks of which skills the agent loaded.
export const SKILL_CHECKS = {
  skill_loaded: holds(["skill"], skillLoaded, {
    scores: "The agent loaded that skill.",
  }),
  skill_not_loaded: fails(["skill"], skillLoaded, {
    scores: "The agent did not load that skill.",
  }),
};
