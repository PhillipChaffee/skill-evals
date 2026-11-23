import { afterEach, expect, test } from "vitest";
import { checkScore } from "./index.js";
import type { RuledCheck } from "./index.js";
import { regex } from "./rules.js";
import { OverBudget, budgeted, setMatchBudget } from "./big-match.js";
import { bareOutcome } from "../testing/outcome.js";

// Over 16 KB, so a pattern's test of it runs in a worker thread under `budgeted`.
const LARGE = `${"a".repeat(70_000)}needle`;
// A pattern that takes seconds on LARGE: each start scans to the end and back.
const SLOW = ".*X.*Y";
const SHORT_BUDGET_MS = 200;

afterEach(() => {
  setMatchBudget();
});

/**
 * Scores a check with its rule under `budgeted`, as a run does.
 * @param check - The check, with its weight added.
 * @param outcome - What the run left behind.
 * @returns The verdict.
 */
const run = (check: Omit<RuledCheck, "weight">, outcome = bareOutcome()) =>
  budgeted(() => checkScore({ ...check, weight: 1 }, outcome));

test("a large final answer is matched in a worker and scores as it would on the main thread", async () => {
  const outcome = bareOutcome({ finalText: LARGE });
  expect(
    await run({ type: "output_matches", pattern: "needle$" }, outcome),
  ).toMatchObject({ score: 1 });
  expect(
    await run({ type: "output_lacks", pattern: "needle$" }, outcome),
  ).toMatchObject({ score: 0 });
  expect(
    await run({ type: "output_matches", pattern: "^b" }, outcome),
  ).toMatchObject({ score: 0 });
});

test("a large tool input is matched in a worker by a matcher", async () => {
  const outcome = bareOutcome({
    toolCalls: [
      { name: "Write", kind: "write", input: { content: LARGE }, index: 0 },
      { name: "Bash", kind: "shell", input: { command: "ls" }, index: 1 },
    ],
  });
  const verdict = await run(
    { type: "tool_called", inputMatches: "needle", min: 1, max: 1 },
    outcome,
  );
  expect(verdict).toMatchObject({ score: 1 });
});

test("a pattern over its budget on a large text throws OverBudget with the size", async () => {
  setMatchBudget(SHORT_BUDGET_MS);
  const outcome = bareOutcome({ finalText: LARGE });
  const started = Date.now();
  await expect(
    run({ type: "output_matches", pattern: SLOW }, outcome),
  ).rejects.toThrow(
    new OverBudget("the pattern took longer than 0.2 s on 69 KB"),
  );
  expect(Date.now() - started).toBeLessThan(SHORT_BUDGET_MS * 10);
});

test("a small text, or a pattern not at position 0, is tested on the spot", async () => {
  expect(await budgeted(() => regex("b").test("abc"))).toBe(true);
  const sticky = regex("needle", "g");
  sticky.lastIndex = 1;
  expect(await budgeted(() => sticky.test(LARGE))).toBe(true);
  // Outside `budgeted` every test is made here.
  expect(regex("needle$").test(LARGE)).toBe(true);
});

test("a rule that throws on the first pass's false answer runs again with the worker's answer", async () => {
  let passes = 0;
  const answer = await budgeted(() => {
    passes += 1;
    if (!regex("needle").test(LARGE)) throw new Error("no needle");
    return "found";
  });
  expect(answer).toBe("found");
  expect(passes).toBe(2);
  await expect(
    budgeted(() => {
      throw new Error("broken");
    }),
  ).rejects.toThrow("broken");
});

test("a pattern that fails in the worker rejects with the worker's error", async () => {
  // The backtracking stack of this pattern overflows on a long text, in the worker as it would here.
  const long = "a".repeat(5_000_000);
  await expect(budgeted(() => regex("(a|b)*c").test(long))).rejects.toThrow(
    "Maximum call stack size exceeded",
  );
});

test("the size that counts is UTF-8 bytes, and one pass can send several texts to the worker", async () => {
  // 10,000 characters: 30 KB of three-byte characters is large, 10 KB of ASCII is not.
  const euros = `${"€".repeat(10_000)}needle`;
  const ascii = `${"a".repeat(10_000)}needle`;
  const tested: string[] = [];
  const both = await budgeted(() => {
    const found = [euros, LARGE, ascii].map((text) =>
      regex("needle$").test(text),
    );
    tested.push(found.join());
    return found;
  });
  expect(both).toEqual([true, true, true]);
  // The first pass sent the two large texts and tested the small one at once.
  expect(tested).toEqual(["false,false,true", "true,true,true"]);
});
