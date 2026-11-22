import path from "node:path";
import { expect, test } from "vitest";
import { applicability } from "./applicability.js";
import { loadCases } from "./cases.js";
import type { ToolCall } from "./harnesses/shared.js";
import { skillEvents } from "./skill-events.js";
import type { Given } from "./testing/outcome.js";
import { bareOutcome, scored } from "./testing/outcome.js";
import {
  CLAUDE_CODE,
  DELEGATE,
  RESEARCHER,
  check,
  harnessOf,
} from "./testing/attribution.js";
import { plantCase, script, skillsFolder } from "./testing/plant.js";
import { readResults, sandbox } from "./testing/sandbox.js";
import { parse } from "./testing/streams.js";

const AGENTS = "claude-code-agents.stream.jsonl";
const MAIN = "main";
const CALLERS = "Two callers";
const MODE = "magic-mode";
const GENERAL = "general-purpose";

test("transcript checks scope to an agent's text, and first_message reads the main agent", () => {
  expect(
    check({
      type: "transcript_matches",
      pattern: CALLERS,
      by: { agent: GENERAL },
    }).score,
  ).toBe(1);
  expect(
    check({ type: "transcript_matches", pattern: CALLERS, by: "main" }).score,
  ).toBe(0);
  expect(
    check({ type: "transcript_lacks", pattern: CALLERS, by: "main" }).score,
  ).toBe(1);
  expect(
    check({
      type: "transcript_matches",
      pattern: "Splitting",
      scope: "first_message",
    }).score,
  ).toBe(1);
  expect(
    check({
      type: "transcript_matches",
      pattern: "^Reading the code",
      scope: "first_message",
      by: { agent: RESEARCHER },
    }).score,
  ).toBe(1);
  expect(
    check({
      type: "transcript_matches",
      pattern: "Both agents are done",
      scope: "final_message",
    }).score,
  ).toBe(1);
  expect(
    check({
      type: "transcript_matches",
      pattern: "Found it",
      scope: "final_message",
      by: { agent: RESEARCHER },
    }).score,
  ).toBe(1);
  expect(
    check({
      type: "transcript_matches",
      pattern: "Change made",
      scope: "final_message",
    }).score,
  ).toBe(0);
});

test("tool_output checks scope to an agent through their tool matcher", () => {
  expect(
    check({
      type: "tool_output_matches",
      tool: { kind: "search", by: { agent: GENERAL } },
      pattern: "src/b.ts",
    }).score,
  ).toBe(1);
  expect(
    check({
      type: "tool_output_matches",
      tool: { kind: "read", by: "main" },
      pattern: "export",
    }).score,
  ).toBe(0);
});

test("skill events carry the agent, so skill_loaded takes by", () => {
  const parsed = parse(CLAUDE_CODE, AGENTS).toolCalls;
  const calls: ToolCall[] = [
    ...parsed,
    {
      name: "Skill",
      kind: "skill",
      input: { skill: "workflow" },
      agent: { id: "d", type: DELEGATE, parent: "main", depth: 1 },
    },
  ];
  const events = skillEvents(
    calls,
    { skillDirs: {} },
    {
      home: "",
      workspace: "",
      pathOf: () => null,
      skillOf: (c) => (c.input as { skill?: string }).skill ?? null,
    },
  );
  expect(events.map((one) => [one.skill, one.agent?.type])).toEqual([
    [MODE, MAIN],
    ["workflow", DELEGATE],
  ]);
  const run = bareOutcome({ toolCalls: calls, skillEvents: events });
  const loaded = (
    skill: string,
    by: NonNullable<Given["by"]>,
    more: Partial<Given> = {},
  ) => scored({ type: "skill_loaded", skill, by, ...more }, run).score;
  expect(loaded("workflow", { agent: DELEGATE })).toBe(1);
  expect(loaded("workflow", "main")).toBe(0);
  expect(loaded(MODE, "main")).toBe(1);
  expect(loaded(MODE, "subagent")).toBe(0);
  expect(
    scored({ type: "skill_not_loaded", skill: "workflow", by: "main" }, run)
      .score,
  ).toBe(1);
  expect(
    scored({ type: "skill_not_loaded", skill: "workflow", by: "subagent" }, run)
      .score,
  ).toBe(0);
  // The first: the main thread's first call is the load, and the delegate made calls before its own.
  expect(loaded(MODE, "main", { first: true })).toBe(1);
  expect(loaded("workflow", "subagent", { first: true })).toBe(0);
  expect(
    loaded("workflow", "subagent", {
      first: true,
      ignoring: [
        { by: "subagent", kind: "read" },
        { by: "subagent", kind: "edit" },
        { by: "subagent", kind: "subagent" },
        { by: "subagent", kind: "search" },
      ],
    }),
  ).toBe(1);
});

test("a by check on a harness without child calls is not applicable", () => {
  const dir = path.resolve(import.meta.dirname, "../examples/cases");
  const [loaded] = loadCases(dir, "by-agent");
  expect(loaded).toBeDefined();
  if (!loaded) return;
  expect(applicability(harnessOf("codex"), loaded)).toMatchObject({
    applicable: false,
    missing: ["childCalls", "childText"],
  });
  expect(applicability(harnessOf(CLAUDE_CODE), loaded)).toEqual({
    applicable: true,
    skipped: [],
  });
});

test("a by on a skill check or on a matcher needs childCalls, and on a transcript check childText", () => {
  const codex = harnessOf("codex");
  const needs = (checks: unknown[]) => {
    const box = sandbox();
    plantCase(box, checks);
    const [loaded] = loadCases(path.join(box.root, "cases"));
    return loaded && applicability(codex, loaded);
  };
  expect(
    needs([{ type: "skill_loaded", skill: "a", by: "main" }]),
  ).toMatchObject({ missing: ["childCalls"] });
  expect(
    needs([
      {
        type: "tool_order",
        before: { kind: "read", by: "main" },
        after: { kind: "edit" },
      },
    ]),
  ).toMatchObject({ missing: ["childCalls"] });
  expect(
    needs([{ type: "transcript_matches", pattern: "x", by: "main" }]),
  ).toMatchObject({ missing: ["childText"] });
  expect(needs([{ type: "tool_called", kind: "read" }])).toMatchObject({
    applicable: true,
  });
});

test("scripted nesting reaches the run record with depth 2", async () => {
  const box = sandbox();
  script(box, "nest", {
    turns: [
      [
        { call: { name: "Read", input: { file_path: "a.md" } } },
        {
          agent: {
            type: "magic:lead:lead",
            prompt: "lead",
            steps: [
              {
                agent: {
                  type: "worker",
                  prompt: "work",
                  steps: [
                    {
                      call: { name: "Edit", input: { file_path: "src/w.ts" } },
                    },
                  ],
                },
              },
              { text: "lead done" },
            ],
          },
        },
        { final: "all done" },
      ],
    ],
  });
  const cases = plantCase(box, [
    { type: "tool_called", kind: "edit", by: { agent: "worker" } },
    { type: "tool_not_called", kind: "edit", by: "main" },
    { type: "transcript_matches", pattern: "lead done", by: { agent: "lead" } },
  ]);
  const outDir = path.join(box.root, "results");
  const subject = skillsFolder(box, "skills", { bro: "# bro\n" });
  const ran = await box.cli([
    "score",
    ...["--subject", subject, "--cases", cases],
    ...["--reps", "1", "--out", outDir],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  const [record] = readResults(outDir).records;
  expect(
    record?.toolCalls.map((one) => [
      one.name,
      one.agent?.type,
      one.agent?.depth,
    ]),
  ).toEqual([
    ["Read", "main", 0],
    ["Agent", "main", 0],
    ["Agent", "lead", 1],
    ["Edit", "worker", 2],
  ]);
  expect(record?.score).toBe(1);
});

test("a by inside a scope needs childCalls, and a lacks check by an agent that wrote nothing fails closed", () => {
  const codex = harnessOf("codex");
  const needs = (scope: unknown) => {
    const box = sandbox();
    plantCase(box, [{ type: "transcript_matches", pattern: "x", scope }]);
    const [loaded] = loadCases(path.join(box.root, "cases"));
    return loaded && applicability(codex, loaded);
  };
  for (const side of ["before", "after"]) {
    expect(needs({ [side]: { kind: "edit", by: "subagent" } })).toMatchObject({
      missing: ["childCalls"],
    });
  }
  const none = check({
    type: "transcript_lacks",
    pattern: "x",
    by: { agent: "grunt" },
  });
  expect(none.score).toBe(0);
  expect(none.reason).toBe("no agent of type grunt ran");
  expect(
    check({
      type: "transcript_matches",
      pattern: "Reading",
      scope: { first_message: true, before: { kind: "edit" } },
      by: { agent: RESEARCHER },
    }).score,
  ).toBe(1);
  expect(
    check({
      type: "transcript_matches",
      pattern: "Reading",
      scope: { after: { kind: "read", by: { agent: RESEARCHER } } },
      by: { agent: RESEARCHER },
    }).score,
  ).toBe(0);
});

test("by also scopes the 0.0.1 skill rule kept under --lenient", () => {
  const calls = parse(CLAUDE_CODE, AGENTS).toolCalls;
  const run = bareOutcome({ toolCalls: calls, legacySkillLoads: true });
  const loaded = (by: NonNullable<Given["by"]>) =>
    scored({ type: "skill_loaded", skill: "workflow", by }, run).score;
  expect(loaded({ agent: DELEGATE })).toBe(1);
  expect(loaded("main")).toBe(0);
});
