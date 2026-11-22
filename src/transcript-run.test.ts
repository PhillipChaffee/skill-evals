import path from "node:path";
import { expect, test } from "vitest";
import type { RuledCheck } from "./checks/index.js";
import { scoredNow } from "./testing/outcome.js";
import { call, played } from "./testing/transcript.js";
import { textPart } from "./transcript.js";
import { applicability } from "./applicability.js";
import { loadCases } from "./cases.js";
import type { Harness } from "./harnesses/shared.js";
import { HARNESSES } from "./harnesses/index.js";
import { plantCase, script, skillsFolder } from "./testing/plant.js";
import { readResults, sandbox } from "./testing/sandbox.js";

// `notes.txt` holds "planted"; the check command fails until an edit writes "fixed" into it.
const RUN =
  "grep -q fixed notes.txt && echo 'all passed' || { echo '1 failed'; exit 1; }";
const CHECKS = [
  {
    type: "tool_output_matches",
    tool: { kind: "shell", inputMatches: "grep -q fixed" },
    which: "first",
    pattern: "\\bfail",
  },
  {
    type: "tool_output_matches",
    tool: { kind: "shell", inputMatches: "grep -q fixed" },
    which: "last",
    pattern: "\\bpass",
  },
];
const FIX = {
  call: {
    name: "Edit",
    input: { file_path: "notes.txt" },
    write: { path: "notes.txt", content: "fixed\n" },
  },
};
const RUN_STEP = {
  call: { name: "Bash", input: { command: RUN }, exec: true },
};

/**
 * Plays a script against the planted case and scores its two checks.
 * @param steps - What the scripted agent does.
 * @returns The scores of the checks, in order.
 */
async function play(steps: object[]): Promise<(number | null)[]> {
  const box = sandbox();
  script(box, "red", { turns: [steps] } as never);
  const cases = plantCase(box, CHECKS);
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    ...["score", "--subject", skillsFolder(box, "skills", { bro: "# bro\n" })],
    ...["--cases", cases, "--reps", "1", "--out", out],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  return (readResults(out).records[0]?.checks ?? []).map(({ score }) => score);
}

test("red before green: a failing run, an edit and a passing run score 1 and 1", async () => {
  expect(await play([RUN_STEP, FIX, RUN_STEP, { final: "done" }])).toEqual([
    1, 1,
  ]);
});

test("red before green: the agent only claims success and runs true", async () => {
  const claim = { text: "Everything passes now." };
  const quiet = {
    call: { name: "Bash", input: { command: "true" }, exec: true },
  };
  expect(await play([claim, FIX, quiet, { final: "All passed." }])).toEqual([
    0, 0,
  ]);
});

test("red before green: a run that never passes fails the last check only", async () => {
  expect(await play([RUN_STEP, RUN_STEP, { final: "done" }])).toEqual([1, 0]);
});

test("a check that needs tool outputs or assistant text is not applicable where the stream has none", () => {
  const box = sandbox();
  const cursor = HARNESSES.find((one) => one.id === "cursor") as Harness;
  const needs = (check: object) =>
    applicability(
      cursor,
      loadCases(plantCase(box, [check]))[0] as never,
      new Set(),
    );
  const tool = { kind: "shell" };
  expect(
    needs({ type: "tool_output_matches", tool, pattern: "a" }),
  ).toMatchObject({
    applicable: false,
    missing: ["toolOutputs"],
  });
  expect(needs({ type: "transcript_matches", pattern: "a" })).toMatchObject({
    applicable: false,
    missing: ["assistantText"],
  });
  expect(
    needs({ type: "transcript_matches", pattern: "a", where: "tool_input" }),
  ).toMatchObject({ applicable: true });
});

test("the example's rm -rf check passes when the edit is the last call", () => {
  const [example] = loadCases(
    path.resolve(import.meta.dirname, "../examples/cases"),
    "transcript-matches",
  );
  const check = example?.checks.find((one) => one.type === "transcript_lacks");
  const run = played(
    textPart("I will change the timeout fallback to 30."),
    call("Edit", { file_path: "src/config.js" }, "a"),
  );
  expect(scoredNow(check as RuledCheck, run).score).toBe(1);
});
