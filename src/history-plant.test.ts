import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { caseHash } from "./run-key.js";
import claudeCode from "./harnesses/claude-code.js";
import type { Harness } from "./harnesses/shared.js";
import { recordedMode } from "./history.js";
import { plantHistory } from "./history-plant.js";
import { inputHash } from "./input-hash.js";
import {
  plantSeeded,
  scoreSeeded,
  seededLoad,
  twelveMessages,
} from "./testing/history-case.js";
import { nativeHistory } from "./testing/native-history.js";
import { sandbox } from "./testing/sandbox.js";

const RUN = { harness: "claude-code", model: undefined };
const PREAMBLE = /^Earlier in this conversation \(12 messages\):/;
const SESSION = {
  id: "a",
  startedAt: "2026-01-01",
  messages: [{ role: "user", text: "hi" }],
};

test("history and sessions count in inputHash and caseHash", () => {
  const messages = twelveMessages();
  const other = [...messages.slice(0, 11), { role: "assistant", text: "x" }];
  const a = seededLoad({ history: messages }).load();
  const b = seededLoad({ history: other }).load();
  const none = seededLoad({}).load();
  const sessions = seededLoad({ sessions: [SESSION] }).load();
  if (!a || !b || !none || !sessions) throw new Error("not loaded");
  const under = (mode: "native" | "preamble" | null) => ({
    ...RUN,
    historyMode: mode,
  });
  expect(inputHash(a, under("preamble"))).not.toBe(
    inputHash(b, under("preamble")),
  );
  expect(inputHash(a, under("preamble"))).not.toBe(
    inputHash(a, under("native")),
  );
  expect(inputHash(a, RUN)).toBe(inputHash(a, under(null)));
  expect(caseHash(a)).not.toBe(caseHash(b));
  // A case with no history has the hash it had before there was one, whatever mode is asked.
  expect(inputHash(none, RUN)).toBe(inputHash(none, under("native")));
  expect(inputHash(sessions, RUN)).not.toBe(inputHash(none, RUN));
  expect(caseHash(sessions)).not.toBe(caseHash(none));
});

test("planting says why it failed, and keeps the adapter's own default mode", () => {
  const where = {
    home: "/nonexistent-home",
    workspace: "/nonexistent-workspace",
  };
  const history = twelveMessages();
  const run = { harness: claudeCode, layers: { history } };
  expect(plantHistory({ ...run, historyMode: "native" }, where).failure).toBe(
    "could not plant the history: claude-code has no native history store",
  );
  expect(
    plantHistory({ harness: claudeCode, layers: { sessions: [] } }, where)
      .failure,
  ).toMatch(/claude-code has no prior-session store/);
  const broken = plantHistory(
    { harness: nativeHistory, layers: { history }, historyMode: "native" },
    where,
  );
  expect(broken.failure).toMatch(/^could not plant the history: ENOENT/);
  // An adapter that names native as its own default is planted natively without the flag.
  const native: Harness = {
    ...nativeHistory,
    historyMode: "native",
    installHistory: () => ({ session: "abc" }),
  };
  expect(
    plantHistory({ harness: native, layers: { history } }, where),
  ).toMatchObject({
    session: "abc",
    preamble: null,
    failure: null,
  });
  const forced = plantHistory(
    { harness: native, layers: { history }, historyMode: "preamble" },
    where,
  );
  expect(forced.preamble).toMatch(PREAMBLE);
  expect(recordedMode({ caseDef: { history }, harness: native })).toBe(
    "native",
  );
  expect(recordedMode({ caseDef: {}, harness: native })).toBeNull();
});

test("the history goes in front of turn 1 only", async () => {
  const box = sandbox();
  plantSeeded(box, "two-turns", { history: twelveMessages() });
  fs.rmSync(path.join(box.root, "cases/two-turns/prompt.md"));
  box.write("cases/two-turns/first.md", "first message\n");
  box.write("cases/two-turns/second.md", "second message\n");
  box.write("cases/two-turns/case.json", {
    turns: [
      { prompt: "first.md" },
      {
        prompt: "second.md",
        checks: [{ type: "output_contains", text: "history" }],
      },
    ],
    checks: [{ type: "output_contains", text: "history" }],
  });
  const { ran, results } = await scoreSeeded(box);
  expect(ran.status, ran.stderr).toBe(0);
  const [first, second] = (results?.records[0]?.userTurns ?? []).map(
    ({ finalText }) =>
      JSON.parse(finalText) as { prompt: string; history: { mode: string } },
  );
  expect(first?.prompt).toMatch(
    new RegExp(`${PREAMBLE.source}[\\s\\S]*\\n\\nfirst message$`),
  );
  expect(second?.prompt).toBe("second message");
  expect(second?.history.mode).toBe("none");
});
