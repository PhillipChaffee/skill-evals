import path from "node:path";
import { expect, test } from "vitest";
import { script } from "./testing/plant.js";
import { exec } from "./testing/runs.js";
import { sandbox } from "./testing/sandbox.js";
import {
  compacting,
  planted,
  played,
  say,
  scored,
} from "./testing/turns-run.js";

test("a session id that differs from the one the turn was given invalidates the run", async () => {
  const box = sandbox();
  planted(box, [{ prompt: "one.md" }, { prompt: "two.md" }]);
  script(box, "talk", {
    match: { prompt: "do talk" },
    sessions: ["sess-A", "sess-B"],
    turns: [[{ final: "one" }], [{ final: "two" }]],
  });
  const { results } = await scored(box);
  const [record] = results.records;
  expect(record?.error).toBe(
    "turn 2 continued session sess-A but reported sess-B",
  );
  expect(record?.score).toBeNull();
  expect(record?.userTurns?.map(({ sessionId }) => sessionId)).toEqual([
    "sess-A",
    "sess-B",
  ]);
});

test("the last turn gets exactly what is left of the whole run's limit", async () => {
  const box = sandbox();
  planted(box, [{ prompt: "one.md" }, { prompt: "two.md" }], {
    timeoutSeconds: 30,
    totalTimeoutSeconds: 2,
  });
  script(box, "talk", {
    match: { prompt: "do talk" },
    turns: [[exec("sleep 0.4"), { final: "one" }], [{ hang: true }]],
  });
  const { results } = await scored(box);
  const [record] = results.records;
  // The limit in the words of the error is the run's, not a rounded-up share of it, and the run does not overrun it.
  expect(record?.error).toBe("turn 2: timed out after 2 s");
  expect(record?.stoppedBy).toBe("timeout");
  expect(record?.durationMs).toBeLessThan(2400);
});

test("a compaction after the last message does not replace the final text", async () => {
  const box = sandbox();
  script(box, "talk", {
    match: { prompt: "first" },
    turns: [[{ final: "the answer" }]],
  });
  const ran = await played(box, compacting, [
    say("a.md", "first"),
    { event: "compact", checks: [] },
  ]);
  expect(ran.error).toBeNull();
  expect(ran.parsed.finalText).toBe("the answer");
});

test("a reason in a turn names calls as the whole run and show do", async () => {
  const box = sandbox();
  planted(box, [
    { prompt: "one.md" },
    {
      prompt: "two.md",
      checks: [
        {
          type: "tool_order",
          before: { kind: "shell", inputMatches: "echo c" },
          after: { kind: "edit" },
        },
      ],
    },
  ]);
  script(box, "talk", {
    match: { prompt: "do talk" },
    turns: [
      [exec("echo a"), exec("echo b"), { final: "one" }],
      [
        {
          call: {
            name: "Edit",
            input: { file_path: "x", old_string: "a", new_string: "b" },
          },
        },
        exec("echo c"),
        { final: "two" },
      ],
    ],
  });
  const { ran, results } = await scored(box);
  expect(ran.status, ran.stderr).toBe(0);
  const reason = String(results.records[0]?.checks[1]?.reason);
  // Turn 2's calls are the run's third and fourth, not its first and second.
  expect(reason).toContain(
    "the first shell call #3 is not before the first edit call #2",
  );
  expect(reason).toMatch(/^#2 t\d /m);
  const shown = await box.cli(["show", path.join(box.root, "results"), "talk"]);
  expect(shown.stdout).toMatch(/call #3 .*echo c/);
  expect(shown.stdout).toMatch(/call #2 /);
});
