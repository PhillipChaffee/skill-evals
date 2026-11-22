import { expect, test } from "vitest";
import type { Check, Outcome } from "./checks/index.js";
import claudeCode from "./harnesses/claude-code.js";
import { session } from "./session.js";
import { sandbox } from "./testing/sandbox.js";
import { emptyParse, mergeTurns } from "./turn-merge.js";
import { slicesOf, storedSlices, viewFor } from "./turn-outcome.js";
import type { Turn } from "./turn-spec.js";

const CHECKS: Check[] = [];

const say = (text: string): Turn => ({
  prompt: text,
  file: `${text}.md`,
  checks: CHECKS,
});

/**
 * Runs two turns through the session runner with the fake harness.
 * @param more - What differs from a plain run.
 * @param more.invoke - Makes the second turn an invocation.
 * @param more.total - The seconds all turns may take.
 * @param more.onTimeout - What a timeout means.
 * @returns What the session produced.
 */
function played(more: {
  invoke?: boolean;
  total?: number;
  onTimeout?: "score";
}) {
  const box = sandbox();
  const turns: Turn[] = [
    say("one"),
    more.invoke ? { invoke: { skill: "bug-fix" }, checks: CHECKS } : say("two"),
  ];
  return session(
    {
      harness: claudeCode,
      bin: String(box.env["SKILL_EVALS_BIN_CLAUDE_CODE"]),
      subject: null,
      prompt: "unused",
      turns,
      timeoutSeconds: 30,
      totalTimeoutSeconds: more.total,
      onTimeout: more.onTimeout,
    },
    (result) => result,
  );
}

test("an invocation on a harness with no user syntax fails the run and names the turn", async () => {
  await expect(played({ invoke: true })).rejects.toThrow(
    "turn 2 (invoke bug-fix): claude-code has no user syntax to invoke a skill",
  );
});

test("a run with no time left for a turn stops as a timeout, which is invalid unless the case scores it", async () => {
  const invalid = await played({ total: 0 });
  expect(invalid).toMatchObject({
    stoppedBy: "timeout",
    error: "timed out after 0 s",
  });
  expect(invalid.userTurns?.map(({ skipped }) => skipped)).toEqual([
    "stopped",
    "stopped",
  ]);
  const scored = await played({ total: 0, onTimeout: "score" });
  expect(scored).toMatchObject({ stoppedBy: "timeout", error: null });
});

const OUTCOME = { turns: undefined } as unknown as Outcome;

test("a check of a turn that a stored run has no record of scores 0 with the reason", () => {
  const check: Check = { type: "tool_called", weight: 1, turn: 2 };
  expect(viewFor(check, OUTCOME)).toBe("turn 2 has no record");
  const ofCase: Check = { type: "tool_called", weight: 1 };
  expect(viewFor(ofCase, OUTCOME)).toBe(OUTCOME);
  const run = {
    toolCalls: [],
    skillEvents: [],
    userTurns: [
      {
        turn: 1,
        kind: "prompt" as const,
        skipped: null,
        finalText: "a",
        loaded: null,
        sessionId: null,
      },
    ],
  };
  // A stored run from before the turns had no changes: the slice shows none, and the turn still has its text.
  expect(storedSlices(run, [])).toMatchObject({
    turns: [
      { finalText: "a", changed: { created: [], modified: [], deleted: [] } },
    ],
  });
  expect(storedSlices({ toolCalls: [], skillEvents: [] }, [])).toEqual({});
  expect(
    slicesOf({
      parsed: { toolCalls: [], transcript: [] },
      events: [],
      userTurns: run.userTurns,
      turnChanges: [],
    }),
  ).toHaveLength(1);
});

test("the merged parse keeps the last process's limit flags", () => {
  const hit = { ...emptyParse(), hitMaxTurns: true, unfinished: true };
  expect(mergeTurns([emptyParse(), hit], [true, true])).toMatchObject({
    hitMaxTurns: true,
    unfinished: true,
  });
});
