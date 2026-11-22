import path from "node:path";
import { expect, test } from "vitest";
import { describeCheck } from "./checks/index.js";
import { script } from "./testing/plant.js";
import { exec } from "./testing/runs.js";
import { sandbox } from "./testing/sandbox.js";
import { emptyParse, mergeTurns } from "./turn-merge.js";
import type { TranscriptEvent } from "./harnesses/shared.js";
import { numbered, callPart, textPart } from "./transcript.js";

const TOOL_CALLED = { type: "tool_called", kind: "shell" };

/**
 * Plants a two-turn case with a check on the second turn.
 * @param box - The sandbox.
 * @returns The cases directory.
 */
function plantTalk(box: ReturnType<typeof sandbox>): string {
  box.write("cases/talk/one.md", "do talk, first\n");
  box.write("cases/talk/two.md", "the follow-up\n");
  box.write("cases/talk/case.json", {
    checks: [{ type: "skill_not_loaded", skill: "nothing" }],
    turns: [
      { prompt: "one.md" },
      { prompt: "two.md", checks: [{ ...TOOL_CALLED, weight: 3 }] },
    ],
  });
  return path.join(box.root, "cases");
}

test("a check of a turn is named by its turn", () => {
  expect(describeCheck({ ...TOOL_CALLED, weight: 1, turn: 2 } as never)).toBe(
    "turn 2 tool_called shell",
  );
  expect(describeCheck({ ...TOOL_CALLED, weight: 1 } as never)).toBe(
    "tool_called shell",
  );
});

test("the report names the checks of a turn, and list and explain show the turns", async () => {
  const box = sandbox();
  const cases = plantTalk(box);
  script(box, "talk", {
    match: { prompt: "do talk" },
    turns: [[{ final: "one" }], [exec("ls"), { final: "two" }]],
  });
  const out = path.join(box.root, "results");
  const ran = await box.cli(
    [
      ...["score", "--subject", "none", "--cases", cases, "--reps", "1"],
      "--out",
      out,
    ],
    { PATH: `${String(box.env["PATH"])}:/usr/local/bin:/usr/bin:/bin` },
  );
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("turn 2 tool_called shell");
  const listed = await box.cli(["list", "--cases", cases]);
  expect(listed.stdout).toContain("talk: 2 checks");
  const explained = await box.cli(["explain", "talk", "--cases", cases]);
  expect(explained.status, explained.stderr).toBe(0);
  const shown = JSON.parse(
    /```json\n(.*?)\n```/s.exec(explained.stdout)?.[1] ?? "{}",
  ) as {
    turns: { prompt: string; checks: { turn: number; min: number }[] }[];
    requiredCapabilities: string[];
  };
  expect(shown.turns.map(({ prompt }) => prompt)).toEqual([
    "do talk, first",
    "the follow-up",
  ]);
  expect(shown.turns[1]?.checks[0]).toMatchObject({ turn: 2, min: 1 });
  expect(shown.requiredCapabilities).toContain("multiTurn");
  const validated = await box.cli([
    "validate",
    "--cases",
    cases,
    "--subject",
    "none",
  ]);
  expect(validated.status, validated.stdout).toBe(0);
});

/**
 * Makes the parse of one harness process: a text and a call.
 * @param turn - The assistant turn of both events, which a real process counts from 1.
 * @param cost - The dollars the process reported; null for one that states none.
 * @returns The parse, with the final text, session id and usage of that process.
 */
const parseOf = (turn: number, cost: number | null) => {
  const transcript = numbered([
    { ...textPart("hello", { turn }), turn },
    {
      ...callPart(
        {},
        { name: "Bash", input: { command: "ls" }, callId: `c${String(turn)}` },
        { turn },
      ),
    },
  ]);
  return {
    ...emptyParse(transcript),
    finalText: `final ${String(turn)}`,
    sessionId: `s${String(turn)}`,
    tokens: { input: 10, output: 5 },
    agentTokens: { main: { input: 10, output: 5 } },
    costUsd: cost,
    toolCalls: [],
  };
};

test("merging turns renumbers events and calls, marks each with its turn, and sums usage", () => {
  const merged = mergeTurns(
    [parseOf(1, 0.5), emptyParse(), parseOf(1, 0.25)],
    [true, false, true],
  );
  expect(merged.transcript.map(({ index }) => index)).toEqual([0, 1, 2, 3]);
  expect(merged.transcript.map(({ userTurn }) => userTurn)).toEqual([
    1, 1, 3, 3,
  ]);
  // The assistant turns of the second process continue those of the first.
  expect(merged.transcript.map((event: TranscriptEvent) => event.turn)).toEqual(
    [1, 1, 2, 2],
  );
  expect(
    merged.toolCalls.map(({ index, userTurn }) => [index, userTurn]),
  ).toEqual([
    [0, 1],
    [1, 3],
  ]);
  expect(merged.finalText).toBe("final 1");
  expect(merged.sessionId).toBe("s1");
  expect(merged.tokens).toEqual({ input: 20, output: 10 });
  expect(merged.agentTokens).toEqual({ main: { input: 20, output: 10 } });
  expect(merged.costUsd).toBeCloseTo(0.75);
});

test("a cost that one turn does not state leaves the sum unstated, and no turn's usage is null", () => {
  const merged = mergeTurns([parseOf(1, 0.5), parseOf(1, null)], [true, true]);
  expect(merged.costUsd).toBeNull();
  const none = mergeTurns([emptyParse()], [false]);
  expect(none).toMatchObject({
    finalText: "",
    tokens: null,
    agentTokens: null,
    costUsd: null,
    sessionId: null,
  });
});
