import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { applicability, applicabilityUnder } from "./applicability.js";
import claudeCode from "./harnesses/claude-code.js";
import { BLINDING, CASES, play, scores } from "./testing/target.js";
import {
  installNativeHistory,
  nativeHistory,
} from "./testing/native-history.js";

test("catch-up from history: twelve messages, two open decisions, and a prompt that tells the agent nothing about being graded", () => {
  const [found] = loadCases(CASES, "catch-up-from-history");
  expect(found?.history).toHaveLength(12);
  expect(found?.prompt).not.toMatch(BLINDING);
  // The history reads as a conversation too: nothing in it names a test or a grade.
  expect(JSON.stringify(found?.history)).not.toMatch(BLINDING);
  // It runs where a preamble can: every adapter, and not an adapter that is held to native only.
  expect(found && applicability(claudeCode, found).applicable).toBe(true);
  expect(
    found &&
      applicabilityUnder(nativeHistory, found, {
        host: new Set(),
        forced: "native",
      }).applicable,
  ).toBe(true);
});

test("catch-up from history: an answer that writes nothing, opens with what is waiting and names both decisions scores 1, in either mode", async () => {
  const preamble = await play("catch-up-from-history.match");
  expect(scores(preamble)).toEqual([1, 1, 1, 1, 1, 1]);
  expect(preamble.historyMode).toBe("preamble");
  installNativeHistory();
  const native = await play("catch-up-from-history.match", [
    "--history-mode",
    "native",
  ]);
  expect(scores(native)).toEqual([1, 1, 1, 1, 1, 1]);
  expect(native.historyMode).toBe("native");
});

test("catch-up from history: an edit or a write fails its own check, though the words are right", async () => {
  expect(scores(await play("catch-up-from-history.edits"))).toEqual([
    1, 0, 1, 1, 1, 0,
  ]);
  expect(scores(await play("catch-up-from-history.writes"))).toEqual([
    0, 1, 1, 1, 1, 0,
  ]);
});

test("catch-up from history: a summary that gets to the waiting decisions only in its second sentence fails the first-sentence check", async () => {
  expect(scores(await play("catch-up-from-history.late-summary"))).toEqual([
    1, 1, 0, 1, 1, 1,
  ]);
});

test("catch-up from history: naming one decision fails the check for the other", async () => {
  expect(scores(await play("catch-up-from-history.one-decision"))).toEqual([
    1, 1, 1, 1, 0, 1,
  ]);
});

test("catch-up from history: a first sentence that only contains the word open is not the answer's opening", async () => {
  // "Let me open the job config" is in the first message, and the closing answer says nothing is waiting.
  expect(scores(await play("catch-up-from-history.let-me-open"))).toEqual([
    1, 1, 0, 1, 1, 1,
  ]);
});

test("catch-up from history: a shell edit fails the check that nothing changed, though no edit call was made", async () => {
  expect(scores(await play("catch-up-from-history.sed-edit"))).toEqual([
    1, 1, 1, 1, 1, 0,
  ]);
});
