import { onTestFinished } from "vitest";
import claudeCode from "../harnesses/claude-code.js";
import { HARNESSES } from "../harnesses/index.js";
import type { Harness } from "../harnesses/shared.js";

/**
 * Claude Code as a harness that has a confirmed user syntax. Claude Code itself does not declare `userInvoke` until a
 * real model has shown that a `/skill args` prompt loads the skill in a `-p` process; tests of the invoke turn use this.
 */
export const userInvoking: Harness = {
  ...claudeCode,
  capabilities: new Set([...claudeCode.capabilities, "userInvoke"]),
  userInvocation: ({ skill, args }) =>
    args === undefined || args === "" ? `/${skill}` : `/${skill} ${args}`,
};

/**
 * Puts `userInvoking` in the place of Claude Code in the list of harnesses until the test ends, so that the command
 * line runs it.
 */
export function installUserInvoking(): void {
  const place = HARNESSES.findIndex(({ id }) => id === claudeCode.id);
  const before = HARNESSES[place] as Harness;
  HARNESSES[place] = userInvoking;
  onTestFinished(() => {
    HARNESSES[place] = before;
  });
}
