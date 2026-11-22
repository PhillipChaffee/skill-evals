import type { Given } from "./outcome.js";
import { bareOutcome, scored } from "./outcome.js";
import { HARNESSES } from "../harnesses/index.js";
import type { Harness } from "../harnesses/shared.js";
import { parse } from "./streams.js";

export const CLAUDE_CODE = "claude-code";
export const RESEARCHER = "researcher-mid";
export const DELEGATE = "delegate";

/**
 * Scores a check against the run of the hand-built fixture: a main thread, two agents and a grandchild.
 * @param given - The check, without its weight.
 * @returns Its verdict.
 */
export const check = (given: Given) => {
  const parsed = parse(CLAUDE_CODE, "claude-code-agents.stream.jsonl");
  return scored(
    given,
    bareOutcome({
      toolCalls: parsed.toolCalls,
      transcript: parsed.transcript,
      finalText: parsed.finalText,
    }),
  );
};

/**
 * Finds an adapter.
 * @param id - An adapter identifier such as `codex`.
 * @returns The adapter of that id.
 */
export const harnessOf = (id: string): Harness =>
  HARNESSES.find((one) => one.id === id) as Harness;
