import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { PriorSession } from "./history-types.js";
import {
  plantSeeded,
  scoreSeeded,
  twelveMessages,
} from "./testing/history-case.js";
import { installNativeHistory } from "./testing/native-history.js";
import { sandbox } from "./testing/sandbox.js";
import { installUserInvoking } from "./testing/user-invoke.js";

const NATIVE = ["--history-mode", "native"];
const SESSIONS_CASE = "with-sessions";
const NATIVE_CASE = "needs-native";
const OLDER: PriorSession = {
  id: "older-one",
  startedAt: "2026-01-05T09:00:00Z",
  messages: [
    { role: "user", text: "start the migration" },
    { role: "assistant", text: "migration started" },
  ],
};
const NEWER: PriorSession = {
  id: "newer-one",
  startedAt: "2026-01-06T09:00:00Z",
  cwd: "/srv/other project",
  messages: [{ role: "user", text: "check the cache" }],
};

test("sessionStore plants files where the adapter says", async () => {
  // The harness's store holds both sessions, and the history is not one of them.
  installNativeHistory();
  const box = sandbox();
  plantSeeded(box, SESSIONS_CASE, {
    sessions: [OLDER, NEWER],
    caseFile: {
      checks: [
        { type: "output_contains", text: "older-one" },
        { type: "output_contains", text: "newer-one" },
        { type: "files_changed_only", root: "home", allow: ["nothing/**"] },
      ],
    },
  });
  const { ran, results, seen } = await scoreSeeded(box);
  expect(ran.status, ran.stderr).toBe(0);
  expect(seen[0]?.sessions).toEqual(["newer-one", "older-one"]);
  expect(seen[0]?.history.mode).toBe("none");
  // Planted files are in the seed of the home, so they are not the agent's changes.
  expect(results?.records[0]?.checks.map(({ score }) => score)).toEqual([
    1, 1, 1,
  ]);
  expect(results?.records[0]?.historyMode).toBeNull();
});

test("planted session files are not reported as agent changes", async () => {
  installNativeHistory();
  const box = sandbox();
  plantSeeded(box, "seeded", {
    history: twelveMessages(),
    sessions: [OLDER],
    caseFile: {
      checks: [
        { type: "files_changed_only", root: "home", allow: ["nothing/**"] },
        {
          type: "file_exists",
          root: "home",
          path: ".claude/projects/**/*.jsonl",
          created: true,
        },
      ],
    },
  });
  const { ran, results, seen } = await scoreSeeded(box, NATIVE);
  expect(ran.status, ran.stderr).toBe(0);
  const [record] = results?.records ?? [];
  // Nothing created or modified in the home, and the file check cannot call a planted file the agent's creation.
  expect(record?.checks.map(({ score }) => score)).toEqual([1, 0]);
  expect(seen[0]?.sessions).toEqual(["older-one"]);
  expect(seen[0]?.history.messages).toBe(12);
});

test("a case with sessions on a harness without a store is not applicable", async () => {
  const box = sandbox();
  plantSeeded(box, SESSIONS_CASE, { sessions: [OLDER] });
  plantSeeded(box, "plain");
  const { ran, results } = await scoreSeeded(box);
  expect(ran.status, ran.stderr).toBe(0);
  expect(results?.records.map(({ caseId }) => caseId)).toEqual(["plain"]);
  expect(results?.notApplicable).toEqual([
    expect.objectContaining({
      caseId: SESSIONS_CASE,
      missing: ["sessionStore"],
      reason: "needs sessionStore",
    }),
  ]);
});

test("a case requiring historyNative is not applicable on a preamble adapter", async () => {
  const box = sandbox();
  plantSeeded(box, NATIVE_CASE, {
    history: twelveMessages(),
    caseFile: { requires: ["historyNative"] },
  });
  plantSeeded(box, "plain");
  const preamble = await scoreSeeded(box);
  expect(preamble.results?.notApplicable[0]).toMatchObject({
    caseId: NATIVE_CASE,
    missing: ["historyNative"],
  });
  // An adapter that can write natively still runs a preamble by default, which cannot meet the need.
  installNativeHistory();
  const defaulted = await scoreSeeded(box);
  expect(defaulted.results?.notApplicable.map(({ caseId }) => caseId)).toEqual([
    NATIVE_CASE,
  ]);
  const forced = await scoreSeeded(box, ["--history-mode", "preamble"]);
  expect(forced.results?.notApplicable.map(({ caseId }) => caseId)).toEqual([
    NATIVE_CASE,
  ]);
  // Natively it runs.
  const native = await scoreSeeded(box, NATIVE);
  expect(native.results?.notApplicable).toEqual([]);
  expect(native.results?.records.map(({ caseId }) => caseId).sort()).toEqual([
    NATIVE_CASE,
    "plain",
  ]);
});

test("forced --history-mode native on a preamble adapter is not applicable", async () => {
  const box = sandbox();
  plantSeeded(box, "seeded", { history: twelveMessages() });
  plantSeeded(box, "plain");
  const { ran, results } = await scoreSeeded(box, NATIVE);
  // It is not a usage error: the case has no run, and the reason names what the harness lacks.
  expect(ran.status, ran.stderr).toBe(0);
  expect(results?.records.map(({ caseId }) => caseId)).toEqual(["plain"]);
  expect(results?.notApplicable[0]).toMatchObject({
    caseId: "seeded",
    missing: ["historyNative"],
    reason: "needs historyNative",
  });
  expect(ran.stdout).toMatch(
    /## Not applicable[\s\S]*seeded[\s\S]*historyNative/,
  );
});

test("a history before a slash command is not applicable under preamble", async () => {
  // The harness can take a user invocation, so only the block in front of the command is in the way.
  installUserInvoking();
  const box = sandbox();
  plantSeeded(box, "invoking", {
    history: twelveMessages(),
    caseFile: {
      turns: [
        {
          invoke: { skill: "release-notes" },
          checks: [{ type: "output_contains", text: "x" }],
        },
      ],
    },
  });
  fs.rmSync(path.join(box.root, "cases/invoking/prompt.md"));
  plantSeeded(box, "plain");
  const { results } = await scoreSeeded(box);
  expect(results?.notApplicable).toEqual([
    expect.objectContaining({ caseId: "invoking", missing: ["historyNative"] }),
  ]);
});

test("a change to history.json re-runs the case on resume (inputHash)", async () => {
  const box = sandbox();
  plantSeeded(box, "catch-up", { history: twelveMessages() });
  const first = await scoreSeeded(box);
  expect(first.ran.status, first.ran.stderr).toBe(0);
  const started = (): number =>
    fs.existsSync(box.started)
      ? fs.readFileSync(box.started, "utf8").trim().split("\n").length
      : 0;
  expect(started()).toBe(1);
  const resume = (): Promise<Awaited<ReturnType<typeof scoreSeeded>>> =>
    scoreSeeded(box, ["--resume", first.out], { KEEP_RUNS: "1" });
  await resume();
  // Nothing changed, so the run is reused.
  expect(started()).toBe(1);
  const changed = twelveMessages();
  changed[11] = { role: "assistant", text: "a different last answer" };
  box.write("cases/catch-up/history.json", changed);
  const again = await resume();
  expect(started()).toBe(2);
  expect(again.results?.records[0]?.inputHash).not.toBe(
    first.results?.records[0]?.inputHash,
  );
});
