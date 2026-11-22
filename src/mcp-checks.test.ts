import { expect, test } from "vitest";
import { matches } from "./matchers.js";
import { mcpToolOf } from "./mcp/names.js";
import type { AgentRef, ToolCall } from "./harnesses/shared.js";
import type { Given } from "./testing/outcome.js";
import { bareOutcome, scored } from "./testing/outcome.js";
import { lines, parseText } from "./testing/streams.js";

const GET_ISSUE = "tracker.get_issue";
const MAIN: AgentRef = { id: "main", type: "main", parent: null, depth: 0 };

/**
 * Makes the agent of a type, one level below the main thread.
 * @param type - The agent's type, which a check's `by.agent` names.
 * @returns The agent.
 */
const subagent = (type: string): AgentRef => ({
  id: type,
  type,
  parent: "main",
  depth: 1,
});

/**
 * Makes a call of an MCP tool as an adapter reads it.
 * @param name - The call's name, `<server>.<tool>`.
 * @param by - The type of the subagent that made it, or `main` for the main thread.
 * @returns The call, with the agent attached.
 */
const mcpCall = (name: string, by: string): ToolCall => ({
  name,
  kind: "mcp",
  input: {},
  agent: by === "main" ? MAIN : subagent(by),
});

test("claude-code maps mcp__server__tool to kind mcp and the name server.tool", () => {
  const use = (id: string, name: string) => ({
    type: "tool_use",
    id,
    name,
    input: { id: "SHOP-7" },
  });
  const parsed = parseText(
    "claude-code",
    lines(
      {
        type: "assistant",
        message: {
          id: "m1",
          content: [
            use("a", "mcp__tracker__get_issue"),
            use("b", "mcp__wiki__get__page"),
            use("c", "mcp__broken"),
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "a", content: "SHOP-7: Cart" },
          ],
        },
      },
    ),
  );
  expect(parsed.toolCalls.map((call) => [call.kind, call.name])).toEqual([
    ["mcp", GET_ISSUE],
    // The server is the part up to the next `__`; the rest is the tool.
    ["mcp", "wiki.get__page"],
    ["other", "mcp__broken"],
  ]);
  const result = parsed.transcript.find((e) => e.type === "tool_result");
  expect([result?.kind, result?.name, result?.output]).toEqual([
    "mcp",
    GET_ISSUE,
    "SHOP-7: Cart",
  ]);
  expect(mcpToolOf("mcp__a__")).toBeNull();
  expect(mcpToolOf("mcp____t")).toBeNull();
  expect(mcpToolOf("Read")).toBeNull();
});

test("each server called by exactly one subagent", () => {
  const investigators = [
    ["tracker", "tracker-investigator"],
    ["wiki", "wiki-investigator"],
    ["chat", "chat-investigator"],
  ] as const;
  // Each server is called by its own investigator, which calls no other server.
  const checks = investigators.flatMap(([server, type]): Given[] => [
    {
      type: "tool_called",
      kind: "mcp",
      name: `^${server}\\.`,
      by: { agent: type },
      min: 1,
      max: 2,
    },
    {
      type: "tool_not_called",
      kind: "mcp",
      name: `^(?!${server}\\.)`,
      by: { agent: type },
    },
  ]);
  const own = investigators.map(([server, type]) =>
    mcpCall(`${server}.read`, type),
  );
  const run = (calls: ToolCall[]) =>
    checks.map(
      (check) => scored(check, bareOutcome({ toolCalls: calls })).score,
    );
  expect(run(own)).toEqual([1, 1, 1, 1, 1, 1]);
  // The wiki's investigator also reads the tracker: it fails its own keep-to-one check and no other.
  const crossed = [...own, mcpCall("tracker.read", "wiki-investigator")];
  expect(run(crossed)).toEqual([1, 1, 1, 0, 1, 1]);
  // The main thread reading the chat is no subagent: the chat's count by its investigator is still 1.
  expect(run([...own, mcpCall("chat.read", "main")])).toEqual([
    1, 1, 1, 1, 1, 1,
  ]);
  // A server nobody called: its investigator's count is 0.
  expect(run(own.slice(0, 2))[4]).toBe(0);
  // Three calls to one server by its own investigator is over the count.
  const tracker = mcpCall("tracker.read", "tracker-investigator");
  expect(run([...own, tracker, tracker])[0]).toBe(0);
});

test("no write-type call", () => {
  const check: Given = {
    type: "tool_not_called",
    kind: "mcp",
    name: "\\.(add_|update_|post_)",
  };
  const run = (...names: string[]) =>
    scored(
      check,
      bareOutcome({ toolCalls: names.map((name) => mcpCall(name, "main")) }),
    );
  expect(run(GET_ISSUE, "chat.read_channel").score).toBe(1);
  const wrote = run(GET_ISSUE, "chat.post_message");
  expect(wrote.score).toBe(0);
  expect(wrote.reason).toContain("chat.post_message");
  // The harness's own write tool is no MCP call: the kind says which tools a check means.
  const own: ToolCall = { name: "Write", kind: "write", input: {} };
  const noWrite: Given = { type: "tool_not_called", kind: "write" };
  expect(scored(noWrite, bareOutcome({ toolCalls: [own] })).score).toBe(0);
});

test("kind other without a name matches mcp calls as in 0.0.1, and with a name it does not", () => {
  const call = mcpCall(GET_ISSUE, "main");
  const shell: ToolCall = { name: "Bash", kind: "shell", input: {} };
  expect(matches({ kind: "other" }, call)).toBe(true);
  expect(matches({ kind: "other", inputMatches: "." }, call)).toBe(true);
  expect(matches({ kind: "other", name: "tracker" }, call)).toBe(false);
  expect(matches({ kind: "other" }, shell)).toBe(false);
  expect(matches({ kind: "mcp", name: "tracker" }, call)).toBe(true);
  expect(matches({ kind: "mcp" }, { ...call, kind: "other" })).toBe(false);
  const check = (given: Given) =>
    scored(given, bareOutcome({ toolCalls: [call] })).score;
  expect(check({ type: "tool_called", kind: "other", min: 1 })).toBe(1);
  const named: Given = {
    type: "tool_called",
    kind: "other",
    name: "tracker",
    min: 1,
  };
  expect(check(named)).toBe(0);
});
