import { expect, test } from "vitest";
import {
  agentEvents,
  historyEvents,
  renderPreamble,
  withHistory,
} from "./history.js";
import { event } from "./transcript.js";
import {
  plantSeeded,
  scoreSeeded,
  twelveMessages,
} from "./testing/history-case.js";
import { REJUDGED, resultsIn } from "./testing/rejudge.js";
import { sandbox } from "./testing/sandbox.js";

const OPEN = {
  role: "assistant" as const,
  text: "looking",
  toolCalls: [{ name: "Read", input: { file_path: "a" } }],
};

test("a call with no output has no result event and no result line in the preamble", () => {
  const events = historyEvents([OPEN]);
  expect(events.map(({ type }) => type)).toEqual(["text", "tool_call"]);
  expect(renderPreamble([OPEN])).not.toContain("[tool result]");
  expect(renderPreamble([OPEN])).toContain(
    '[tool call] Read {"file_path":"a"}',
  );
});

test("history events come first in the file, and agentEvents takes them out again", () => {
  const seeded = historyEvents(twelveMessages());
  const own = [
    event({ role: "assistant", type: "text", text: "hi" }, 0),
    event({ role: "assistant", type: "text", text: "bye" }, 1),
  ];
  const both = withHistory(seeded, own);
  expect(both.map(({ index }) => index)).toEqual(both.map((_, at) => at));
  expect(both.filter(({ userTurn }) => userTurn === -1)).toHaveLength(14);
  expect(agentEvents(both)).toEqual(own);
  // With no history nothing is copied: the very lists come back.
  expect(withHistory([], own)).toBe(own);
  expect(agentEvents(own)).toBe(own);
});

test("rejudge scores a run that has a history from the agent's own events, and show marks the history", async () => {
  const box = sandbox();
  const cases = plantSeeded(box, "catch-up", {
    history: twelveMessages(),
    caseFile: {
      checks: [
        { type: "tool_called", name: "Bash" },
        { type: "tool_not_called", name: "Bash" },
        { type: "tool_output_size", maxBytes: 1 },
      ],
    },
  });
  const { ran, out, results } = await scoreSeeded(box);
  expect(ran.status, ran.stderr).toBe(0);
  const first = results?.records[0]?.checks.map(({ score }) => score);
  expect(first).toEqual([0, 1, 1]);
  const again = await box.cli(["rejudge", out, "--cases", cases]);
  expect(again.status, again.stderr).toBe(0);
  expect(
    resultsIn(out, REJUDGED).records[0]?.checks.map(({ score }) => score),
  ).toEqual(first);
  const shown = await box.cli(["show", out, "catch-up"]);
  expect(shown.status, shown.stderr).toBe(0);
  const lines = shown.stdout.split("\n");
  expect(lines.filter((line) => line.includes(" [history] "))).toHaveLength(14);
  // The seeded call carries no number, which only the agent's own calls get.
  expect(
    lines.some((line) => line.includes("[history]") && line.includes("call #")),
  ).toBe(false);
});
