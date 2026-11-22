import path from "node:path";
import { expect, test } from "vitest";
import { applicability } from "./applicability.js";
import { loadCases } from "./cases.js";
import type { Harness } from "./harnesses/shared.js";
import { HARNESSES } from "./harnesses/index.js";
import { inputHash } from "./input-hash.js";
import { mergeMockLog } from "./mcp/merge.js";
import { parseLog, readLogText } from "./mcp/stage.js";
import type { McpCall } from "./mcp/types.js";
import { caseHash } from "./run-key.js";
import { sandbox } from "./testing/sandbox.js";
import { lines, parseText } from "./testing/streams.js";

const CASE_FILE = "cases/c/case.json";
const PROMPT_FILE = "cases/c/prompt.md";
const TOOL_PATH = "cases/c/mcp/s/t.json";
const CHECKS = { checks: [{ type: "output_contains", text: "x" }] };
const TOOL = {
  description: "d",
  inputSchema: {},
  responses: [{ text: "one" }],
};
const CLAUDE = "claude-code";
const MOCK_LOG = "mock-log";
const QUALIFIED = "tracker.get_issue";
const GO = "go\n";
const LATER = "2026-01-02T00:00:00Z";
const LATE_TIME = "2026-01-01T00:00:09Z";
const TIME = "2026-01-01T00:00:01Z";

/**
 * Finds a harness.
 * @param id - A harness identifier such as `codex`.
 * @returns The adapter.
 */
function harness(id: string): Harness {
  const found = HARNESSES.find((one) => one.id === id);
  if (!found) throw new Error(`no harness ${id}`);
  return found;
}

/**
 * Loads the only case of a sandbox.
 * @param root - The sandbox root.
 * @returns The case.
 */
function loadOnly(root: string) {
  const [found] = loadCases(path.join(root, "cases"));
  if (!found) throw new Error("no case");
  return found;
}

test("an mcp case on a harness without mcp is not applicable", () => {
  const box = sandbox();
  box.write(PROMPT_FILE, GO);
  box.write(CASE_FILE, CHECKS);
  box.write(TOOL_PATH, TOOL);
  const mcpCase = loadOnly(box.root);
  expect(applicability(harness(CLAUDE), mcpCase)).toEqual({
    applicable: true,
    skipped: [],
  });
  for (const id of ["codex", "cursor", "opencode", "pi"]) {
    expect(applicability(harness(id), mcpCase), id).toMatchObject({
      applicable: false,
      missing: ["mcp"],
      reason: "needs mcp",
    });
  }
  // Without the directory the same case applies everywhere.
  const plain = { ...mcpCase, mcp: undefined };
  expect(applicability(harness("pi"), plain).applicable).toBe(true);
});

test("the mcp directory counts in the case hash and the input hash, and the hashes do not name where it was loaded from", () => {
  const box = sandbox();
  box.write(PROMPT_FILE, GO);
  box.write(CASE_FILE, CHECKS);
  box.write(TOOL_PATH, TOOL);
  const run = { harness: CLAUDE, model: undefined };
  const before = loadOnly(box.root);
  const was = { case: caseHash(before), input: inputHash(before, run) };
  const changed = { ...TOOL, responses: [{ text: "two" }] };
  box.write(TOOL_PATH, changed);
  const after = loadOnly(box.root);
  expect(caseHash(after)).not.toBe(was.case);
  expect(inputHash(after, run)).not.toBe(was.input);
  const copy = sandbox();
  copy.write(PROMPT_FILE, GO);
  copy.write(CASE_FILE, CHECKS);
  copy.write(TOOL_PATH, changed);
  const moved = loadOnly(copy.root);
  expect(caseHash(moved)).toBe(caseHash(after));
  expect(inputHash(moved, run)).toBe(inputHash(after, run));
});

/**
 * Makes a call as the mock log holds it.
 * @param at - When the server answered.
 * @param tool - The tool's name.
 * @returns The logged call.
 */
const logged = (at: string, tool = "get_issue"): McpCall => ({
  server: "tracker",
  tool,
  input: { id: "1" },
  response: { text: "ok", isError: false },
  at,
});

test("the mock log is merged by time when events state one, and last when none do", () => {
  const stream = lines(
    {
      type: "assistant",
      message: {
        id: "m1",
        content: [
          { type: "text", text: "a" },
          { type: "tool_use", id: "x", name: "Read", input: {} },
        ],
      },
    },
    { type: "result", subtype: "success", result: "done" },
  );
  const parsed = parseText(CLAUDE, stream);
  const last = mergeMockLog(parsed, [logged(TIME)]);
  expect(last.transcript.map((e) => [e.type, e.kind, e.source])).toEqual([
    ["text", undefined, undefined],
    ["tool_call", "read", undefined],
    ["tool_call", "mcp", MOCK_LOG],
    ["tool_result", "mcp", MOCK_LOG],
  ]);
  expect(last.transcript.map((e) => e.index)).toEqual([0, 1, 2, 3]);
  expect(last.toolCalls.map((c) => [c.name, c.source, c.agent?.type])).toEqual([
    ["Read", undefined, "main"],
    [QUALIFIED, MOCK_LOG, "unknown"],
  ]);
  // With times: a call goes after the last event that is not later than it.
  const timed = {
    ...parsed,
    transcript: parsed.transcript.map((e, i) => ({
      ...e,
      at: `2026-01-01T00:00:0${String(i * 2)}Z`,
    })),
  };
  const merged = mergeMockLog(timed, [
    logged(TIME),
    logged(LATE_TIME, "later"),
  ]);
  expect(merged.transcript.map((e) => e.name ?? e.type)).toEqual([
    "text",
    QUALIFIED,
    QUALIFIED,
    "Read",
    "tracker.later",
    "tracker.later",
  ]);
  // A call before every stamped event goes first.
  const early = mergeMockLog(timed, [logged("2025-01-01T00:00:00Z")]);
  expect(early.transcript[0]?.source).toBe(MOCK_LOG);
  // Nothing to merge, or a stream that shows its MCP calls already: the run is as it was.
  expect(mergeMockLog(parsed, [])).toBe(parsed);
  expect(mergeMockLog(last, [logged("2026-01-01T00:00:05Z")])).toBe(last);
});

test("the mock log is read whole lines at a time, in time order", () => {
  const box = sandbox();
  const lateFirst = [logged(LATER), logged(TIME)];
  const text = lateFirst.map((call) => JSON.stringify(call)).join("\n");
  const log = box.write("mock.log", `${text}\n{"cut`);
  expect(readLogText(log)).toContain('{"cut');
  expect(parseLog(readLogText(log)).map((call) => call.at)).toEqual([
    TIME,
    LATER,
  ]);
  expect(readLogText(path.join(box.root, "none.log"))).toBe("");
});
