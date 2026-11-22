import path from "node:path";
import { expect, test } from "vitest";
import type { Dispatch } from "./harnesses/shared.js";
import { skillsFolder } from "./testing/plant.js";
import { play, scoreSubject, writeCase } from "./testing/runs.js";
import { sandbox } from "./testing/sandbox.js";
import { lines, parseText } from "./testing/streams.js";
import { CLAUDE_CODE } from "./testing/attribution.js";

const NO_DISPATCH: Dispatch = { type: null, model: null, effort: null };

test("claude code records the type, model and effort of a dispatch, and null where the input has none", () => {
  const stream = lines(
    {
      type: "assistant",
      message: {
        id: "m1",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Agent",
            input: {
              subagent_type: "magic:planner:planner",
              model: "opus",
              effort: "high",
              prompt: "go",
            },
          },
          { type: "tool_use", id: "t2", name: "Task", input: { prompt: "go" } },
          {
            type: "tool_use",
            id: "t3",
            name: "Read",
            input: { file_path: "a" },
          },
        ],
      },
      parent_tool_use_id: null,
    },
    { type: "result", subtype: "success", result: "x" },
  );
  const calls = parseText(CLAUDE_CODE, stream).toolCalls;
  expect(calls[0]?.dispatch).toEqual({
    type: "magic:planner:planner",
    model: "opus",
    effort: "high",
  });
  expect(calls[1]?.dispatch).toEqual(NO_DISPATCH);
  expect(calls[2]).not.toHaveProperty("dispatch");
});

test("an adapter whose stream shows only the dispatch call records null metadata", () => {
  const { toolCalls } = parseText(
    "codex",
    lines({
      type: "item.completed",
      item: {
        type: "collab_tool_call",
        tool: "spawn",
        prompt: "name: planner",
      },
    }),
  );
  expect(toolCalls[0]?.dispatch).toEqual(NO_DISPATCH);
});

test("agent tokens sum the usage of each message by agent, counting a message once", () => {
  const usage = (input: number, output: number, cache = 0) => ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cache,
    cache_creation_input_tokens: 1,
  });
  const message = (id: string, parent: string | null, used?: object) => ({
    type: "assistant",
    message: {
      id,
      content: [{ type: "text", text: id }],
      ...(used === undefined ? {} : { usage: used }),
    },
    parent_tool_use_id: parent,
  });
  const dispatch = {
    type: "assistant",
    message: {
      id: "m2",
      content: [{ type: "tool_use", id: "t1", name: "Agent", input: {} }],
      usage: usage(20, 2),
    },
    parent_tool_use_id: null,
  };
  const parsed = parseText(
    CLAUDE_CODE,
    lines(
      message("m1", null, usage(10, 1, 5)),
      // One message split over two events states its usage in each.
      message("m1", null, usage(10, 1, 5)),
      dispatch,
      message("c1", "t1", usage(7, 3)),
      message("c2", "t1", usage(8, 4)),
      message("c3", "t1"),
      { type: "result", subtype: "success", result: "x", usage: usage(1, 1) },
    ),
  );
  expect(parsed.agentTokens).toEqual({
    main: { input: 10 + 5 + 1 + 20 + 1, output: 1 + 2 },
    t1: { input: 7 + 1 + 8 + 1, output: 3 + 4 },
  });
  // The run's own total is the result event's, unchanged.
  expect(parsed.tokens).toEqual({ input: 2, output: 1 });
  const none = parseText(
    CLAUDE_CODE,
    lines(message("m1", null), {
      type: "result",
      subtype: "success",
      result: "x",
    }),
  );
  expect(none.agentTokens).toBeNull();
  expect(parseText("codex", lines()).agentTokens ?? null).toBeNull();
});

test("a run keeps the dispatch of each subagent call and the tokens of each agent", async () => {
  const box = sandbox();
  const cases = path.join(box.root, "cases");
  writeCase(box, "cases", {
    id: "tokens",
    checks: [
      {
        type: "agent_dispatched",
        agent: "planner",
        modelMatches: "^opus$",
      },
    ],
  });
  play(box, {
    name: "tokens",
    id: "tokens",
    steps: [
      {
        agent: {
          type: "planner",
          prompt: "go",
          model: "opus",
          steps: [
            {
              text: "planning",
              usage: { input_tokens: 4, output_tokens: 2 },
            },
          ],
        },
      },
      { text: "ok", usage: { input_tokens: 9, output_tokens: 1 } },
    ],
  });
  const subject = skillsFolder(box, "skills", { bro: "# bro\n" });
  const ran = await scoreSubject(box, { subject, cases });
  expect(ran.status, ran.stderr).toBe(0);
  const [record] = ran.records;
  expect(record?.checks[0]?.score).toBe(1);
  expect(record?.toolCalls[0]?.dispatch).toEqual({
    type: "planner",
    model: "opus",
    effort: null,
  });
  const tokens = Object.entries(record?.agentTokens ?? {});
  expect(
    tokens.map(([, value]) => value).sort((a, b) => a.input - b.input),
  ).toEqual([
    { input: 4, output: 2 },
    { input: 9, output: 1 },
  ]);
  expect(record?.agentTokens).toHaveProperty("main");
});
