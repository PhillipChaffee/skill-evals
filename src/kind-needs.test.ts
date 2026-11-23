import path from "node:path";
import { expect, test } from "vitest";
import { CHECKS } from "./checks/index.js";
import type { Check } from "./checks/index.js";
import { readResults, sandbox } from "./testing/sandbox.js";

// What a harness must report for a matcher kind: a harness without it never shows a call of that kind.
const NEEDED = { question: "askUser", mcp: "mcp", subagent: "subagents" };

/**
 * Lists what a check needs, as its type says.
 * @param check - A check as a case writes it.
 * @returns The capabilities the check type asks of a harness.
 */
const needsOf = (check: Record<string, unknown>): string[] =>
  CHECKS[String(check["type"])]?.needs?.(check as unknown as Check) ?? [];

test("every tool check and every matcher of a kind that needs a capability asks for it", () => {
  for (const [kind, need] of Object.entries(NEEDED)) {
    const matcher = { kind };
    const checks = [
      { type: "tool_called", kind },
      { type: "tool_called", kind, max: 0 },
      { type: "tool_called", kind, sameTurn: true, min: 2 },
      { type: "tool_not_called", kind },
      { type: "first_tool", matches: matcher },
      { type: "first_tool", matches: { kind: "read" }, ignoring: [matcher] },
      { type: "tool_order", before: { kind: "read" }, after: matcher },
      { type: "tool_order", sequence: [{ kind: "read" }, matcher] },
      { type: "tool_output_lacks", tool: matcher, pattern: "x" },
      { type: "transcript_lacks", pattern: "x", scope: { after: matcher } },
    ];
    for (const check of checks) {
      expect(needsOf(check), JSON.stringify(check)).toContain(need);
    }
  }
  expect(
    needsOf({ type: "tool_called", kind: "subagent", sameTurn: true }),
  ).toEqual(["turnGrouping", "subagents"]);
  // A dispatch and the kind ask for the same capability, which is listed once.
  expect(
    needsOf({ type: "tool_called", kind: "subagent", dispatches: "planner" }),
  ).toEqual(["subagents"]);
});

test("the skill kind and the kinds every harness reports need nothing", () => {
  for (const kind of ["skill", "shell", "read", "other"]) {
    expect(needsOf({ type: "tool_not_called", kind }), kind).toEqual([]);
    expect(needsOf({ type: "first_tool", matches: { kind } }), kind).toEqual(
      [],
    );
  }
});

test("on Pi, a check that a question, an MCP call or a subagent was never made is not applicable, never a pass", async () => {
  const box = sandbox();
  const kinds = Object.keys(NEEDED);
  const forms = (kind: string) => ({
    none: { type: "tool_not_called", kind },
    max0: { type: "tool_called", kind, max: 0 },
    first: {
      type: "first_tool",
      matches: { kind: "read" },
      ignoring: [{ kind }],
    },
    order: { type: "tool_order", before: { kind }, after: { kind: "read" } },
  });
  for (const kind of kinds) {
    for (const [form, check] of Object.entries(forms(kind))) {
      box.write(`cases/${kind}-${form}/prompt.md`, `do ${kind} ${form}\n`);
      box.write(`cases/${kind}-${form}/case.json`, { checks: [check] });
    }
  }
  // One case that applies, so the command has something to run.
  box.write("cases/plain/prompt.md", "do plain\n");
  box.write("cases/plain/case.json", {
    checks: [{ type: "tool_not_called", kind: "web" }],
  });
  const out = path.join(box.root, "out");
  const ran = await box.cli(
    [
      ...["score", "--subject", "none", "--reps", "1", "--out", out],
      ...["--cases", path.join(box.root, "cases"), "--harness", "pi"],
    ],
    { SKILL_EVALS_BIN_PI: box.pi },
  );
  expect(ran.status, ran.stderr).toBe(0);
  const results = readResults(out);
  expect(results.records.map((record) => record.caseId)).toEqual(["plain"]);
  const missing = Object.fromEntries(
    results.notApplicable.map((entry) => [entry.caseId, entry.missing]),
  );
  for (const [kind, need] of Object.entries(NEEDED)) {
    for (const form of Object.keys(forms(kind))) {
      expect(missing[`${kind}-${form}`], `${kind}-${form}`).toEqual([need]);
    }
  }
}, 120_000);
