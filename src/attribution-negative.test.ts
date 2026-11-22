import path from "node:path";
import { expect, test } from "vitest";
import { applicability } from "./applicability.js";
import { loadCases } from "./cases.js";
import type { Given } from "./testing/outcome.js";
import { bareOutcome, scored } from "./testing/outcome.js";
import { CLAUDE_CODE, check, harnessOf } from "./testing/attribution.js";
import { plantCase } from "./testing/plant.js";
import { sandbox } from "./testing/sandbox.js";

test("every negative check on an agent that never ran fails with one reason", () => {
  const reason = "no agent of type researcher-mdi ran";
  const by = { agent: "researcher-mdi" };
  for (const given of [
    { type: "tool_not_called", kind: "edit", by },
    { type: "tool_called", by, max: 0 },
    { type: "tool_called", by, min: 0 },
    { type: "skill_not_loaded", skill: "workflow", by },
    { type: "transcript_lacks", pattern: "x", by },
    {
      type: "tool_output_lacks",
      tool: { kind: "read", by },
      pattern: "x",
    },
  ] satisfies Given[]) {
    expect(check(given).reason, given.type).toBe(reason);
    expect(check(given).score).toBe(0);
  }
  // A claim about "subagent" with no subagent keeps its plain meaning.
  const alone = scored(
    { type: "tool_not_called", kind: "edit", by: "subagent" },
    bareOutcome(),
  );
  expect(alone.score).toBe(1);
});

test("a duration bound inside a tool matcher or a scope matcher needs toolDurations", () => {
  const claude = harnessOf(CLAUDE_CODE);
  const needs = (checks: unknown[]) => {
    const box = sandbox();
    plantCase(box, checks);
    const [loaded] = loadCases(path.join(box.root, "cases"));
    return loaded && applicability(claude, loaded);
  };
  expect(
    needs([
      {
        type: "tool_output_matches",
        pattern: "x",
        tool: { kind: "shell", minDurationMs: 5 },
      },
    ]),
  ).toMatchObject({ applicable: false, missing: ["toolDurations"] });
  expect(
    needs([
      {
        type: "transcript_matches",
        pattern: "x",
        scope: { before: { kind: "shell", maxDurationMs: 5 } },
      },
    ]),
  ).toMatchObject({ applicable: false, missing: ["toolDurations"] });
});
