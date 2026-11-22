import path from "node:path";
import { expect, test } from "vitest";
import { applicability } from "./applicability.js";
import { loadCases } from "./cases.js";
import type { Dispatch, ToolCall } from "./harnesses/shared.js";
import { describeCheck } from "./checks/index.js";
import { bareOutcome, scored } from "./testing/outcome.js";
import type { Given } from "./testing/outcome.js";
import { plantCase } from "./testing/plant.js";
import { sandbox } from "./testing/sandbox.js";
import { CLAUDE_CODE, check, harnessOf } from "./testing/attribution.js";

const GENERIC = "general-purpose";
const INLINED = "matched by inlined definition";
const NO_DISPATCH: Dispatch = { type: null, model: null, effort: null };

/**
 * Makes a subagent call as an adapter reads it.
 * @param input - The dispatch's input.
 * @param dispatch - What the adapter read from it; the type of `subagent_type`, and no model, by default.
 * @returns The call.
 */
const dispatched = (
  input: Record<string, unknown>,
  dispatch: Partial<Dispatch> = {},
): ToolCall => ({
  name: "Agent",
  kind: "subagent",
  input,
  dispatch: {
    ...NO_DISPATCH,
    type:
      typeof input["subagent_type"] === "string"
        ? input["subagent_type"]
        : null,
    ...dispatch,
  },
});

const run = (given: Given, ...calls: ToolCall[]) =>
  scored(given, bareOutcome({ toolCalls: calls }));

test("agent_dispatched counts by normalized name", () => {
  const prefixed = {
    type: "agent_dispatched",
    agent: "researcher-mid",
  } satisfies Given;
  const verdict = check(prefixed);
  expect(verdict.score).toBe(1);
  expect(verdict.reason).toContain("matched by type");
  // The check's own name is normalized in the same way.
  expect(
    check({
      type: "agent_dispatched",
      agent: "magic:researcher-mid:researcher-mid",
    }).score,
  ).toBe(1);
  expect(check({ ...prefixed, min: 2 }).score).toBe(0);
  expect(
    check({ type: "agent_dispatched", agent: "delegate", max: 0 }).score,
  ).toBe(0);
  expect(
    check({ type: "agent_dispatched", agent: "delegate", max: 1 }).score,
  ).toBe(1);
  // A part of a name is not the name.
  const part = check({ type: "agent_dispatched", agent: "researcher" });
  expect(part.score).toBe(0);
  expect(part.reason).toContain("researcher-mid, delegate");
});

test("agent_dispatched falls back to an inlined definition", () => {
  const inlined = (prompt: string) =>
    dispatched({ subagent_type: GENERIC, prompt });
  const given = {
    type: "agent_dispatched",
    agent: "comment-sicko",
  } satisfies Given;
  // A `name:` line anywhere in the brief.
  const front = run(
    given,
    inlined(
      `${"Goal: tidy up.\n".repeat(60)}---\nname: comment-sicko\n---\nYou review comments.`,
    ),
  );
  expect(front.score).toBe(1);
  expect(front.reason).toContain(INLINED);
  // The bare name, as a whole word in the first 400 characters; a dispatch with no type is generic too.
  const bare = run(
    given,
    dispatched({ prompt: "You are comment-sicko. Review it." }),
  );
  expect(bare.score).toBe(1);
  expect(bare.reason).toContain(INLINED);
  // Past the window the bare name does not count, until the check widens the window.
  const late = inlined(`${"x ".repeat(250)}comment-sicko`);
  expect(run(given, late).score).toBe(0);
  expect(run({ ...given, briefWindow: 1000 }, late).score).toBe(1);
  // A longer name that contains it is another word.
  expect(run(given, inlined("You are comment-sickos.")).score).toBe(0);
  // A dispatch with a type of its own is judged by the type alone.
  expect(
    run(
      given,
      dispatched({ subagent_type: "explore", prompt: "name: comment-sicko" }),
    ).score,
  ).toBe(0);
});

test("briefMatches tests the brief and min and max count the dispatches that match", () => {
  const typed = (prompt: string) =>
    dispatched({ subagent_type: "planner", prompt });
  const calls = [
    typed("Plan the Auth module"),
    typed("Plan the billing module"),
  ];
  const base = { type: "agent_dispatched", agent: "planner" } satisfies Given;
  expect(
    run({ ...base, briefMatches: "billing", max: 1 }, ...calls).score,
  ).toBe(1);
  expect(run({ ...base, briefMatches: "module", min: 2 }, ...calls).score).toBe(
    1,
  );
  expect(run({ ...base, briefMatches: "auth", min: 1 }, ...calls).score).toBe(
    0,
  );
  expect(
    run({ ...base, briefMatches: "auth", flags: "i", max: 1 }, ...calls).score,
  ).toBe(1);
  const none = run({ ...base, briefMatches: "nothing" }, ...calls);
  expect(none.score).toBe(0);
  expect(none.reason).toContain("0 matching dispatches");
  // The description is part of the brief.
  expect(
    run(
      { ...base, briefMatches: "tidy" },
      dispatched({ subagent_type: "planner", description: "Tidy up" }),
    ).score,
  ).toBe(0);
  expect(
    run(
      { ...base, briefMatches: "Tidy" },
      dispatched({ subagent_type: "planner", description: "Tidy up" }),
    ).score,
  ).toBe(1);
});

test("modelMatches reads the dispatch's model, and a dispatch with none does not match", () => {
  const given = {
    type: "agent_dispatched",
    agent: "reviewer",
    modelMatches: "opus",
  } satisfies Given;
  const fast = dispatched(
    { subagent_type: "reviewer" },
    { model: "claude-haiku" },
  );
  const strong = dispatched(
    { subagent_type: "reviewer" },
    { model: "claude-opus-4" },
  );
  expect(run(given, strong).score).toBe(1);
  expect(run(given, fast).score).toBe(0);
  const bare = run(given, dispatched({ subagent_type: "reviewer" }));
  expect(bare.score).toBe(0);
  expect(bare.reason).toContain("the dispatch carries no model");
  expect(
    run({ ...given, max: 0 }, dispatched({ subagent_type: "reviewer" })).score,
  ).toBe(1);
});

test("a planner that was dispatched and produced no events passes a claim that it made no calls", () => {
  const claim = {
    type: "tool_called",
    by: { agent: "research-planner" },
    max: 0,
  } satisfies Given;
  const planner = dispatched({
    subagent_type: "magic:research-planner:research-planner",
  });
  expect(run(claim, planner).score).toBe(1);
  // A typo, an agent that was never dispatched, and a generic dispatch still fail closed.
  expect(
    run({ ...claim, by: { agent: "research-planer" } }, planner).score,
  ).toBe(0);
  expect(run(claim).score).toBe(0);
  expect(
    run(
      claim,
      dispatched({
        subagent_type: GENERIC,
        prompt: "name: research-planner",
      }),
    ).score,
  ).toBe(0);
  expect(run(claim, dispatched({})).reason).toBe(
    "no agent of type research-planner ran",
  );
});

test("agent_dispatched needs subagents, and a harness without them cannot run the case", () => {
  const box = sandbox();
  plantCase(box, [{ type: "agent_dispatched", agent: "planner" }]);
  const [loaded] = loadCases(path.join(box.root, "cases"));
  if (!loaded) throw new Error("no case");
  expect(applicability(harnessOf(CLAUDE_CODE), loaded).applicable).toBe(true);
  expect(applicability(harnessOf("pi"), loaded)).toMatchObject({
    applicable: false,
    missing: ["subagents"],
  });
});

test("agent_dispatched rejects a window that is no positive whole number, and shows in a report line", () => {
  const box = sandbox();
  plantCase(box, [
    { type: "agent_dispatched", agent: "planner", briefWindow: 0 },
  ]);
  expect(() => loadCases(path.join(box.root, "cases"))).toThrow(/briefWindow/);
  const described = describeCheck({
    type: "agent_dispatched",
    agent: "planner",
    briefMatches: "x",
    flags: "i",
    modelMatches: "opus",
    briefWindow: 100,
    min: 2,
    weight: 1,
  });
  expect(described).toContain("agent_dispatched");
  expect(described).toContain("planner");
  expect(described).toContain("briefWindow 100");
  expect(described).toContain("min 2");
});

test("the bare-name rule does not read meaning: a negated mention counts", () => {
  const given = {
    type: "agent_dispatched",
    agent: "research-synthesizer",
  } as const;
  const negated = dispatched({
    subagent_type: GENERIC,
    prompt: "Do not act like the research-synthesizer. Only list files.",
  });
  expect(run(given, negated).reason).toContain(INLINED);
});

test("the dispatches matcher key fits a call by the rule of agent_dispatched, in every matcher", () => {
  const prefixed = dispatched({ subagent_type: "magic:researcher:researcher" });
  const inlined = dispatched({
    subagent_type: GENERIC,
    prompt: "name: researcher\nRead it.",
  });
  const other = dispatched({ subagent_type: "planner", prompt: "researcher" });
  const read: ToolCall = { name: "Read", kind: "read", input: {} };
  const calls = [prefixed, inlined, other, read];
  const count = (given: Given) => run(given, ...calls).score;
  expect(
    count({ type: "tool_called", dispatches: "researcher", min: 2, max: 2 }),
  ).toBe(1);
  expect(count({ type: "tool_called", dispatches: "researcher", min: 3 })).toBe(
    0,
  );
  expect(count({ type: "tool_not_called", dispatches: "planner" })).toBe(0);
  expect(count({ type: "tool_not_called", dispatches: "reviewer" })).toBe(1);
  expect(
    count({
      type: "tool_order",
      before: { dispatches: "researcher", which: "last" },
      after: { dispatches: "planner" },
    }),
  ).toBe(1);
  expect(
    count({ type: "first_tool", matches: { dispatches: "researcher" } }),
  ).toBe(1);
  expect(
    count({
      type: "first_tool",
      matches: { kind: "read" },
      ignoring: [{ dispatches: "researcher" }, { dispatches: "planner" }],
    }),
  ).toBe(1);
  // Only a subagent call can be a dispatch.
  expect(
    run(
      { type: "tool_called", dispatches: "researcher" },
      { name: "Bash", kind: "shell", input: { command: "name: researcher" } },
    ).score,
  ).toBe(0);
});

test("dispatches needs subagents, in a check and in a matcher, and shows in describeCheck", () => {
  const box = sandbox();
  plantCase(box, [
    { type: "tool_called", dispatches: "planner" },
    {
      type: "tool_order",
      sequence: [{ dispatches: "a" }, { dispatches: "b" }],
    },
  ]);
  const [loaded] = loadCases(path.join(box.root, "cases"));
  if (!loaded) throw new Error("no case");
  expect(applicability(harnessOf("pi"), loaded)).toMatchObject({
    applicable: false,
    missing: ["subagents"],
  });
  expect(describeCheck({ ...loaded.checks[0], weight: 1 } as never)).toContain(
    "dispatches planner",
  );
});
