import path from "node:path";
import { expect, test } from "vitest";
import { script } from "./testing/plant.js";
import { exec } from "./testing/runs.js";
import { onlyRecord, REJUDGED } from "./testing/rejudge.js";
import { sandbox } from "./testing/sandbox.js";

const EDIT = {
  call: {
    name: "Edit",
    input: { file_path: "src/a.txt", old_string: "a", new_string: "b" },
    write: { path: "src/a.txt", content: "b\n" },
  },
};
const CHANGED = { type: "file_changed", path: "src" };

/**
 * Plants a two-turn case whose first turn edits a file and whose second runs a command, and scores it.
 * @param turns - The `turns` of the case file.
 * @returns The sandbox, the cases directory, and the output directory.
 */
async function scoredTurns(turns: unknown[]) {
  const box = sandbox();
  box.write("cases/talk/one.md", "do talk, first\n");
  box.write("cases/talk/two.md", "the follow-up\n");
  box.write("cases/talk/workspace/src/a.txt", "a\n");
  box.write("cases/talk/case.json", {
    checks: [{ type: "tool_called", kind: "edit" }],
    turns,
  });
  script(box, "talk", {
    match: { prompt: "do talk" },
    turns: [
      [EDIT, { final: "edited" }],
      [exec("ls src"), { final: "ran" }],
    ],
  });
  const cases = path.join(box.root, "cases");
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    ...["score", "--subject", "none", "--cases", cases, "--reps", "1"],
    ...["--out", out, "--keep-workspaces"],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  return { box, cases, out };
}

test("rejudge scores the checks of each turn again, from the stored slices and changes", async () => {
  const { box, cases, out } = await scoredTurns([
    { prompt: "one.md", checks: [CHANGED] },
    {
      prompt: "two.md",
      checks: [CHANGED, { type: "tool_called", kind: "edit" }],
    },
  ]);
  expect(onlyRecord(out).checks.map(({ score }) => score)).toEqual([
    1, 1, 0, 0,
  ]);
  // Turn 2's checks change; turn 1's stay as they were.
  box.write("cases/talk/case.json", {
    checks: [{ type: "tool_called", kind: "edit" }],
    turns: [
      { prompt: "one.md", checks: [CHANGED] },
      {
        prompt: "two.md",
        checks: [
          { type: "file_unchanged", path: "src" },
          { type: "tool_called", kind: "shell" },
        ],
      },
    ],
  });
  const ran = await box.cli(["rejudge", out, "--cases", cases]);
  expect(ran.status, ran.stderr).toBe(0);
  const again = onlyRecord(out, REJUDGED);
  expect(again.checks.map(({ score, turn }) => [score, turn])).toEqual([
    [1, undefined],
    [1, 1],
    [1, 2],
    [1, 2],
  ]);
  expect(again.userTurns).toHaveLength(2);
});
