import { onTestFinished } from "vitest";
import claudeCode from "../harnesses/claude-code.js";
import {
  installClaudeHistory,
  installClaudeSessions,
} from "../harnesses/claude-code-history.js";
import { HARNESSES } from "../harnesses/index.js";
import type { Harness } from "../harnesses/shared.js";

/**
 * Claude Code as a harness that declares `historyNative` and `sessionStore`. Claude Code itself declares neither until a
 * real model has shown that it resumes a session written the way `claude-code-history.ts` writes it; tests of native
 * history and of session stores use this. It is never exported from the package and is not in the list of harnesses.
 */
export const nativeHistory: Harness = {
  ...claudeCode,
  capabilities: new Set([
    ...claudeCode.capabilities,
    "historyNative",
    "sessionStore",
  ]),
  installHistory: installClaudeHistory,
  installSessions: installClaudeSessions,
};

/**
 * Puts `nativeHistory` in the place of Claude Code in the list of harnesses until the test ends, so that the command
 * line runs it.
 */
export function installNativeHistory(): void {
  const place = HARNESSES.findIndex(({ id }) => id === claudeCode.id);
  const before = HARNESSES[place] as Harness;
  HARNESSES[place] = nativeHistory;
  onTestFinished(() => {
    HARNESSES[place] = before;
  });
}
