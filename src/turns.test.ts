import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { script } from "./testing/plant.js";
import { exec, scoreSubject } from "./testing/runs.js";
import type { Sandbox } from "./testing/sandbox.js";
import { sandbox } from "./testing/sandbox.js";

const EDIT = {
  call: {
    name: "Edit",
    input: { file_path: "src/a.txt", old_string: "a", new_string: "b" },
  },
};
const SHELL_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * Plants a case with two prompt turns.
 * @param box - The sandbox.
 * @param more - Keys of the case file, such as `checks`, and the turns' own keys through `turns`.
 * @returns The cases directory.
 */
function twoTurns(box: Sandbox, more: Record<string, unknown> = {}): string {
  box.write("cases/talk/one.md", "do talk, first\n");
  box.write("cases/talk/two.md", "now the follow-up\n");
  box.write("cases/talk/workspace/src/a.txt", "a\n");
  box.write("cases/talk/case.json", {
    checks: [{ type: "tool_called", kind: "edit" }],
    turns: [{ prompt: "one.md" }, { prompt: "two.md" }],
    ...more,
  });
  return path.join(box.root, "cases");
}

/**
 * Runs the cases of a sandbox with the fake harness.
 * @param box - The sandbox.
 * @returns What `scoreSubject` returns, with the shell's own PATH added so that scripted commands run.
 */
const score = (box: Sandbox) =>
  scoreSubject(box, {
    subject: "none",
    cases: path.join(box.root, "cases"),
    env: { PATH: `${String(box.env["PATH"])}:${SHELL_PATH}` },
  });

test("turn 2 checks see only turn 2's calls", async () => {
  const box = sandbox();
  twoTurns(box, {
    turns: [
      { prompt: "one.md" },
      {
        prompt: "two.md",
        checks: [
          { type: "tool_called", kind: "edit" },
          { type: "tool_called", kind: "shell", inputMatches: "ls" },
          { type: "output_contains", text: "ran it" },
          { type: "output_not_contains", text: "edited" },
        ],
      },
    ],
  });
  script(box, "talk", {
    match: { prompt: "do talk" },
    turns: [
      [EDIT, { final: "edited" }],
      [exec("ls src"), { final: "ran it" }],
    ],
  });
  const { status, stderr, records } = await score(box);
  expect(status, stderr).toBe(0);
  const [record] = records;
  // The case-level check sees the whole session; the turn-2 check for an edit sees none; the others see turn 2 only.
  expect(record?.checks.map(({ score: value }) => value)).toEqual([
    1, 0, 1, 1, 1,
  ]);
  expect(record?.checks[1]).toMatchObject({ type: "tool_called", turn: 2 });
  expect(record?.toolCalls.map(({ userTurn }) => userTurn)).toEqual([1, 2]);
  expect(record?.toolCalls.map(({ index }) => index)).toEqual([0, 1]);
});

test("the second turn continues the first session", async () => {
  const box = sandbox();
  twoTurns(box, {
    checks: [
      { type: "output_matches", pattern: "^resumed fake-session-\\d+$" },
    ],
  });
  script(box, "talk", {
    match: { prompt: "do talk" },
    turns: [[{ final: "first" }], [{ final: "resumed $RESUMED" }]],
  });
  const { status, stderr, records } = await score(box);
  expect(status, stderr).toBe(0);
  const [record] = records;
  expect(record?.score).toBe(1);
  // The id the first turn stated is the one the second was resumed with.
  const stream = fs.readFileSync(
    path.join(
      box.root,
      "results",
      String(record?.transcriptFile).replace(
        ".transcript.json",
        ".stream.jsonl",
      ),
    ),
    "utf8",
  );
  const first = /"session_id":"(fake-session-\d+)"/.exec(stream)?.[1];
  expect(record?.finalText).toBe(`resumed ${String(first)}`);
  // Every turn is one process: the case's second prompt reached a second process.
  expect(fs.readFileSync(box.started, "utf8").trim().split("\n")).toHaveLength(
    2,
  );
});

test("cost is summed across turns", async () => {
  const box = sandbox();
  twoTurns(box);
  script(box, "talk", {
    match: { prompt: "do talk" },
    costUsd: 0.25,
    turns: [[EDIT, { final: "one" }], [{ final: "two" }]],
  });
  const { records } = await score(box);
  const [record] = records;
  expect(record?.costUsd).toBeCloseTo(0.5);
  expect(record?.tokens).toEqual({ input: 2 * (100 + 900), output: 100 });
  expect(record?.userTurns?.map(({ finalText }) => finalText)).toEqual([
    "one",
    "two",
  ]);
});

test("turn 1 made no change under src even through a shell command", async () => {
  const box = sandbox();
  twoTurns(box, {
    checks: [{ type: "file_unchanged", path: "src" }],
    turns: [
      { prompt: "one.md", checks: [{ type: "file_unchanged", path: "src" }] },
      {
        prompt: "two.md",
        checks: [
          { type: "file_unchanged", path: "src" },
          { type: "file_changed", path: "src" },
          { type: "files_changed_only", allow: ["src/**"] },
          { type: "file_exists", path: "src/a.txt" },
        ],
      },
    ],
  });
  script(box, "talk", {
    match: { prompt: "do talk" },
    turns: [
      [exec("cat src/a.txt"), { final: "looked" }],
      // No edit tool: only a shell command changes the file.
      [exec("echo more >> src/a.txt"), { final: "done" }],
    ],
  });
  const { records } = await score(box);
  const [record] = records;
  expect(record?.checks.map(({ score: value }) => value)).toEqual([
    0, 1, 0, 1, 1, 1,
  ]);
  expect(record?.turnChanges).toEqual([
    { created: [], modified: [], deleted: [] },
    { created: [], modified: ["src/a.txt"], deleted: [] },
  ]);
});
