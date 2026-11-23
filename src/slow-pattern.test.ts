import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { setMatchBudget } from "./checks/big-match.js";
import { script } from "./testing/plant.js";
import { readResults, sandbox } from "./testing/sandbox.js";

const SHELL = "/usr/local/bin:/usr/bin:/bin";
const INVALID_EXIT = 3;
// Short, so the test is fast; the pattern below takes seconds on the answer.
const BUDGET_MS = 300;

afterEach(() => {
  setMatchBudget();
});

test("a slow pattern on a large answer leaves its own run invalid and its sibling run valid", async () => {
  setMatchBudget(BUDGET_MS);
  const box = sandbox();
  box.write("cases/slow/prompt.md", "do slow\n");
  box.write("cases/slow/case.json", {
    checks: [{ type: "output_matches", pattern: ".*X.*Y" }],
  });
  box.write("cases/fast/prompt.md", "do fast\n");
  box.write("cases/fast/case.json", {
    timeoutSeconds: 3,
    checks: [{ type: "output_contains", text: "done" }],
  });
  script(box, "slow", {
    match: { prompt: "do slow" },
    turns: [[{ final: "a".repeat(70_000) }]],
  });
  script(box, "fast", {
    match: { prompt: "do fast" },
    turns: [
      [
        { call: { name: "Bash", input: { command: "sleep 1" }, exec: true } },
        { final: "done" },
      ],
    ],
  });
  const out = path.join(box.root, "out");
  const ran = await box.cli(
    [
      ...["score", "--subject", "none", "--reps", "1", "--jobs", "2"],
      ...["--cases", path.join(box.root, "cases"), "--out", out],
    ],
    { PATH: `${String(box.env["PATH"])}:${SHELL}` },
  );
  expect(ran.status, ran.stderr).toBe(INVALID_EXIT);
  const { records } = readResults(out);
  const of = (id: string) => records.filter((record) => record.caseId === id);
  expect(of("fast").map((record) => [record.ok, record.score])).toEqual([
    [true, 1],
  ]);
  for (const record of of("slow")) {
    expect(record.score).toBeNull();
    expect(record.checks[0]).toMatchObject({
      score: null,
      reason: "the pattern took longer than 0.3 s on 69 KB",
    });
  }
}, 60_000);
