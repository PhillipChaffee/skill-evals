import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { applicability } from "./applicability.js";
import type { Case } from "./cases.js";
import { loadCases } from "./cases.js";
import claudeCode from "./harnesses/claude-code.js";
import type { Harness } from "./harnesses/shared.js";
import { script } from "./testing/plant.js";
import { exec } from "./testing/runs.js";
import { installUserInvoking, userInvoking } from "./testing/user-invoke.js";
import type { Sandbox } from "./testing/sandbox.js";
import { sandbox } from "./testing/sandbox.js";
import {
  compacting,
  planted,
  played,
  say,
  scored,
} from "./testing/turns-run.js";
import type { Turn } from "./turn-spec.js";

test("an invoke turn reaches the harness in its user syntax", async () => {
  installUserInvoking();
  const box = sandbox();
  planted(box, [
    { prompt: "one.md" },
    { invoke: { skill: "bug-fix", args: "v2 now" } },
    { invoke: { skill: "refactor" } },
  ]);
  const { ran, results } = await scored(box);
  expect(ran.status, ran.stderr).toBe(0);
  const [record] = results.records;
  // Unscripted, the fake reports the prompt it was given as its final text; the last turn is the bare invocation.
  expect(JSON.parse(String(record?.finalText))).toMatchObject({
    prompt: "/refactor",
  });
  expect(record?.userTurns?.map(({ kind }) => kind)).toEqual([
    "prompt",
    "invoke",
    "invoke",
  ]);
  expect(userInvoking.userInvocation?.({ skill: "a", args: "b c" })).toBe(
    "/a b c",
  );
  expect(userInvoking.userInvocation?.({ skill: "a", args: "" })).toBe("/a");
});

test("a multi-turn case on a harness without multiTurn is not applicable", async () => {
  const box = sandbox();
  planted(box, [{ prompt: "one.md" }, { prompt: "two.md" }]);
  const { ran, results } = await scored(box, "claude-code,pi");
  expect(ran.status, ran.stderr).toBe(0);
  expect(results.suites.find(({ harness }) => harness === "pi")).toMatchObject({
    applicable: 0,
    total: 1,
  });
  expect(ran.stdout).toContain("needs multiTurn");
  expect(results.records.map(({ harness }) => harness)).toEqual([
    "claude-code",
  ]);
});

/**
 * Loads the one case of a sandbox.
 * @param box - The sandbox.
 * @returns The case.
 */
function loaded(box: Sandbox): Case {
  const [one] = loadCases(path.join(box.root, "cases"));
  if (!one) throw new Error("no case");
  return one;
}

test("what a case's turns need is multiTurn, userInvoke and the events", () => {
  const needs = (turns: unknown[]) => {
    const box = sandbox();
    planted(box, turns);
    const verdict = applicability(claudeCode, loaded(box));
    return verdict.applicable ? [] : verdict.missing;
  };
  expect(needs([{ prompt: "one.md" }])).toEqual([]);
  expect(needs([{ prompt: "one.md" }, { event: "clear" }])).toEqual([]);
  expect(
    needs([
      { prompt: "one.md" },
      { event: "compact" },
      { invoke: { skill: "x" } },
    ]),
  ).toEqual(["userInvoke", "compact"]);
  const pi = (turns: unknown[]) => {
    const box = sandbox();
    planted(box, turns);
    const verdict = applicability(
      { ...claudeCode, capabilities: new Set() },
      loaded(box),
    );
    return verdict.applicable ? [] : verdict.missing;
  };
  expect(
    pi([{ prompt: "one.md" }, { invoke: { skill: "x" } }, { event: "resume" }]),
  ).toEqual(["multiTurn", "userInvoke", "resume"]);
});

test("a compact event between turns", async () => {
  const box = sandbox();
  script(box, "talk", {
    match: { prompt: "first" },
    turns: [[{ final: "one" }], [{ final: "two" }]],
  });
  const turns: Turn[] = [
    say("a.md", "first"),
    { event: "compact", checks: [] },
    say("b.md", "second"),
  ];
  const ran = await played(box, compacting, turns);
  expect(ran.error).toBeNull();
  const lifecycle = ran.parsed.transcript.filter(
    ({ type }) => type === "lifecycle",
  );
  expect(lifecycle).toMatchObject([
    { name: "compact", userTurn: 2, role: "system" },
  ]);
  expect(ran.parsed.finalText).toBe("two");
  expect(ran.userTurns?.map(({ kind, skipped }) => [kind, skipped])).toEqual([
    ["prompt", null],
    ["event", null],
    ["prompt", null],
  ]);
  // Claude Code itself does not declare it, so the case is not applicable there.
  const box2 = sandbox();
  planted(box2, [{ prompt: "one.md" }, { event: "compact" }]);
  expect(applicability(claudeCode, loaded(box2))).toMatchObject({
    applicable: false,
    missing: ["compact"],
  });
  expect(applicability(compacting, loaded(box2)).applicable).toBe(true);
});

test("a compaction that the stream does not show fails the run", async () => {
  const box = sandbox();
  const quiet: Harness = {
    ...compacting,
    invocation: (input) =>
      claudeCode.invocation({
        ...input,
        prompt: input.turn.event === "compact" ? "not a command" : input.prompt,
      }),
  };
  const ran = await played(box, quiet, [
    say("a.md", "first"),
    { event: "compact", checks: [] },
  ]);
  expect(ran.error).toBe("turn 2: the harness did not report the compaction");
});

test("clear starts a new session and resume keeps the old one", async () => {
  const box = sandbox();
  script(box, "talk", {
    match: { prompt: "first" },
    turns: [
      [{ final: "one" }],
      [{ final: "resumed:$RESUMED" }],
      [{ final: "resumed:$RESUMED" }],
    ],
  });
  const ran = await played(box, claudeCode, [
    say("a.md", "first"),
    { event: "resume", checks: [] },
    say("b.md", "second"),
    { event: "clear", checks: [] },
    say("c.md", "third"),
  ]);
  const texts = ran.userTurns?.map(({ finalText }) => finalText);
  expect(texts?.[2]).toMatch(/^resumed:fake-session-\d+$/);
  // After the clear no session is continued.
  expect(texts?.[4]).toBe("resumed:");
  expect(
    ran.parsed.transcript
      .filter(({ type }) => type === "lifecycle")
      .map(({ name, userTurn }) => [name, userTurn]),
  ).toEqual([
    ["resume", 2],
    ["clear", 4],
  ]);
});

test("a turn after a missing session id is not sent", async () => {
  const box = sandbox();
  planted(box, [{ prompt: "one.md" }, { prompt: "two.md" }]);
  script(box, "talk", {
    match: { prompt: "do talk" },
    noSessionId: true,
    turns: [[{ final: "one" }], [{ final: "two" }]],
  });
  const { results } = await scored(box);
  const [record] = results.records;
  expect(record?.error).toBe("turn 1 gave no session id to continue");
  expect(record?.score).toBeNull();
  expect(record?.userTurns?.map(({ skipped }) => skipped)).toEqual([
    null,
    "stopped",
  ]);
  // One process only: the second turn was never sent.
  expect(fs.readFileSync(box.started, "utf8").trim().split("\n")).toHaveLength(
    1,
  );
});

test("a stopped turn skips the rest", async () => {
  const box = sandbox();
  planted(
    box,
    [
      { prompt: "one.md" },
      { prompt: "two.md", checks: [{ type: "tool_not_called", kind: "edit" }] },
    ],
    { maxTurns: 3, checks: [{ type: "tool_not_called", kind: "edit" }] },
  );
  script(box, "talk", {
    match: { prompt: "do talk" },
    turns: [[{ limit: true }], [{ final: "never played" }]],
  });
  const { results } = await scored(box);
  const [record] = results.records;
  expect(record?.stoppedBy).toBe("maxTurns");
  expect(record?.userTurns?.map(({ skipped }) => skipped)).toEqual([
    null,
    "stopped",
  ]);
  expect(fs.readFileSync(box.started, "utf8").trim().split("\n")).toHaveLength(
    1,
  );
  // The run is scored, and the check of the turn that was never sent scores 0 and says why.
  expect(record?.checks.map(({ score }) => score)).toEqual([1, 0]);
  expect(record?.checks[1]?.reason).toBe(
    "turn 2 was not run: turn 1 stopped at maxTurns",
  );
});

test("a failing turn is named in the error and later turns are skipped", async () => {
  const box = sandbox();
  planted(box, [{ prompt: "one.md" }, { prompt: "two.md" }]);
  script(box, "talk", {
    match: { prompt: "do talk" },
    turns: [[{ final: "one" }], [{ fail: "boom" }]],
  });
  const { results } = await scored(box);
  const [record] = results.records;
  expect(record?.error).toBe("turn 2: boom");
  expect(record?.score).toBeNull();
});

test("the whole run has a time cap of its own", async () => {
  const box = sandbox();
  planted(box, [{ prompt: "one.md" }, { prompt: "two.md" }], {
    timeoutSeconds: 30,
    totalTimeoutSeconds: 2,
  });
  script(box, "talk", {
    match: { prompt: "do talk" },
    turns: [[exec("sleep 1.5"), { final: "one" }], [{ hang: true }]],
  });
  const { results } = await scored(box);
  const [record] = results.records;
  expect(record?.stoppedBy).toBe("timeout");
  expect(record?.error).toMatch(/^turn 2: /);
});
