import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { exec } from "./exec.js";
import { HARNESSES } from "./harnesses/index.js";
import type { AgentRef, Harness, TranscriptEvent } from "./harnesses/shared.js";
import { lastAssistantText } from "./harnesses/shared.js";
import { fixture, sandbox } from "./testing/sandbox.js";
import { turnWatch } from "./turn-watch.js";

const PI_TURNS = "pi-turns.stream.jsonl";

test("onTimeout is read as a case key: default invalid, and only invalid or score", () => {
  const load = (more: Record<string, unknown>) => {
    const box = sandbox();
    box.write("cases/c/prompt.md", "hi\n");
    box.write("cases/c/case.json", {
      checks: [{ type: "output_not_contains", text: "x" }],
      ...more,
    });
    return loadCases(path.join(box.root, "cases"));
  };

  expect(load({})[0]?.onTimeout).toBe("invalid");
  expect(load({ onTimeout: "score" })[0]?.onTimeout).toBe("score");
  expect(() => load({ onTimeout: "ignore" })).toThrow(
    /"onTimeout" must be "invalid" or "score"/,
  );
});

test("exec stops the process group when onStdout says stop, and that is no failure", async () => {
  const seen: string[] = [];
  const run = await exec(
    process.execPath,
    ["-e", 'console.log("one"); setInterval(() => {}, 1000)'],
    {
      cwd: process.cwd(),
      env: { PATH: process.env["PATH"] },
      timeoutSeconds: 20,
      onStdout: (chunk) => {
        seen.push(chunk);
        return "stop";
      },
    },
  );

  expect(run).toMatchObject({ failure: null, kind: null, stopped: true });
  expect(run.stdout).toBe("one\n");
  expect(run.firstOutputMs).toBeGreaterThanOrEqual(0);
  expect(seen).toEqual(["one\n"]);
});

/**
 * Feeds a stream to a turn watch in chunks that cut lines in two.
 * @param harness - The adapter.
 * @param name - The fixture.
 * @param maxTurns - The limit, or none.
 * @returns What the watch answered to each chunk, and the turns at the end.
 */
function watched(harness: Harness, name: string, maxTurns?: number) {
  const watch = turnWatch(harness, maxTurns);
  const text = fs.readFileSync(fixture(name), "utf8");
  const size = 97;
  const answers: string[] = [];
  for (let at = 0; at < text.length; at += size) {
    answers.push(watch?.onStdout(text.slice(at, at + size)) ?? "none");
  }
  return { answers, turns: watch?.turns() };
}

const byId = (id: string): Harness =>
  HARNESSES.find((harness) => harness.id === id) as Harness;

test.each([
  ["claude-code", "claude-code-turns.stream.jsonl", 5],
  ["pi", PI_TURNS, 3],
  ["opencode", "opencode-turns.stream.jsonl", 3],
])(
  "%s counts the main-thread turns of %s over chunks that cut lines",
  (id, name, turns) => {
    expect(watched(byId(id), name).turns).toBe(turns);
  },
);

test("the watch answers stop as soon as the turns pass the limit, and never without one", () => {
  const limited = watched(byId("pi"), PI_TURNS, 2);
  expect(limited.answers).toContain("stop");
  expect(limited.answers[0]).toBe("continue");
  expect(watched(byId("pi"), PI_TURNS).answers).not.toContain("stop");
});

test("a line that is not JSON is skipped, and a last line with no newline counts at the end", () => {
  const watch = turnWatch(byId("pi"), undefined);
  watch?.onStdout('log line\n{"type":"turn_start"}\n{"type":"turn_start"}');
  expect(watch?.turns()).toBe(2);
});

test("a harness with turnGrouping counts turns, and only such a harness", () => {
  for (const harness of HARNESSES) {
    expect(harness.countTurns !== undefined, harness.id).toBe(
      harness.capabilities.has("turnGrouping"),
    );
    expect(turnWatch(harness, 1) === null, harness.id).toBe(
      !harness.capabilities.has("turnGrouping"),
    );
  }
});

test("the last assistant text of a stopped run is the main thread's, never a subagent's", () => {
  const main: AgentRef = { id: "main", type: "main", parent: null, depth: 0 };
  const child: AgentRef = { id: "t", type: "x", parent: "main", depth: 1 };
  const text = (agent: AgentRef, said: string) =>
    ({ role: "assistant", type: "text", agent, text: said }) as TranscriptEvent;

  expect(
    lastAssistantText([text(main, "first"), text(child, "child says")]),
  ).toBe("first");
  expect(lastAssistantText([])).toBe("");
});
