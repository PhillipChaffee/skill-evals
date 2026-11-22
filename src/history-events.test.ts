import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { renderPreamble } from "./history.js";
import {
  plantSeeded,
  scoreSeeded,
  twelveMessages,
} from "./testing/history-case.js";
import { REJUDGED, resultsIn } from "./testing/rejudge.js";
import { sandbox } from "./testing/sandbox.js";
import { script } from "./testing/plant.js";

const OPEN = {
  role: "assistant" as const,
  text: "looking",
  toolCalls: [{ name: "Read", input: { file_path: "a" } }],
};

test("a call with no output has no result line in the preamble", () => {
  expect(renderPreamble([OPEN])).not.toContain("[tool result]");
  expect(renderPreamble([OPEN])).toContain(
    '[tool call] Read {"file_path":"a"}',
  );
});

test("a command check reads the agent's events and the history apart", async () => {
  const box = sandbox();
  // A grader that rejects any Edit anywhere in the transcript must not see one of the history's.
  const history = [
    { role: "user", text: "fix it" },
    {
      role: "assistant",
      text: "fixing",
      toolCalls: [{ name: "Edit", input: { file_path: "a" }, output: "ok" }],
    },
  ];
  plantSeeded(box, "grader", {
    history,
    caseFile: {
      checks: [
        {
          type: "command",
          run: "node -e \"const t=JSON.parse(require('fs').readFileSync(process.env.SKILL_EVALS_TRANSCRIPT,'utf8'));process.exit(t.some(e=>e.name==='Edit')||t[0].index!==0?1:0)\"",
        },
        {
          type: "command",
          run: "node -e \"const h=JSON.parse(require('fs').readFileSync(process.env.SKILL_EVALS_HISTORY,'utf8'));process.exit(h.length===2&&h[1].toolCalls[0].name==='Edit'?0:1)\"",
        },
      ],
    },
  });
  script(box, "agent", {
    turns: [
      [
        { call: { name: "Read", input: { file_path: "b" } } },
        { final: "done" },
      ],
    ],
  });
  const { ran, results } = await scoreSeeded(box);
  expect(ran.status, ran.stderr).toBe(0);
  expect(results?.records[0]?.checks.map(({ score }) => score)).toEqual([1, 1]);
});

test("rejudge scores a run that has a history, and show prints the agent's own indexes and the history as h0, h1", async () => {
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
  script(box, "agent", {
    turns: [
      [
        { text: "looking" },
        { call: { name: "Read", input: { file_path: "a" }, output: "x" } },
        { final: "done" },
      ],
    ],
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
  // The reason of the first check quotes no call, and the agent's call is `#0`, printed at the index it has in the file.
  expect(lines.find((line) => line.includes("call #0"))).toMatch(/^1: /);
  expect(lines.filter((line) => /^h\d+: /.test(line))).toHaveLength(13);
  expect(lines).toContain(
    'h3: assistant call "Bash" input {"command":"git status"}',
  );
  expect(lines.some((line) => line.startsWith("12: "))).toBe(false);
  const file = path.join(out, results?.records[0]?.transcriptFile ?? "");
  expect(fs.existsSync(file.replace(".transcript.json", ".history.json"))).toBe(
    true,
  );
});
