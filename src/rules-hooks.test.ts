import path from "node:path";
import { expect, test } from "vitest";
import { applicability } from "./applicability.js";
import { loadCases } from "./cases.js";
import claudeCode from "./harnesses/claude-code.js";
import type { Harness } from "./harnesses/shared.js";
import { script } from "./testing/plant.js";
import {
  installInPlaceOfClaude,
  plainSubject,
  reportingRules,
  ruledSubject,
  scoredCase,
} from "./testing/rules.js";
import { sandbox } from "./testing/sandbox.js";

const KIT = "using-the-kit";
const BOOTSTRAP = "Use the using-the-kit skill before you act.";
const NO_SLEEP = "Never sleep longer than 30 seconds.";

test("a hook event in the stream satisfies hook_fired", async () => {
  const box = sandbox();
  script(box, "hook", {
    turns: [
      [
        {
          hook: {
            event: "SessionStart",
            command: "boot.sh",
            exit: 0,
            context: BOOTSTRAP,
          },
        },
        { final: "done" },
      ],
    ],
  });
  const { ran, record } = await scoredCase(box, plainSubject(box), {
    checks: [
      { type: "hook_fired", event: "SessionStart" },
      { type: "hook_fired", event: "Stop" },
      { type: "hook_fired", event: "Stop", max: 0 },
    ],
  });
  expect(ran.status, ran.stderr).toBe(0);
  expect(record?.checks.map((check) => check.score)).toEqual([1, 0, 1]);
  const hook = record?.toolCalls.length;
  expect(hook).toBe(0);
});

test("context_injected matches the injected bootstrap text", async () => {
  const box = sandbox();
  script(box, "hook", {
    turns: [
      [
        {
          hook: {
            event: "SessionStart",
            command: "boot.sh",
            exit: 0,
            context: BOOTSTRAP,
          },
        },
        { final: "done" },
      ],
    ],
  });
  const { record } = await scoredCase(box, plainSubject(box), {
    checks: [
      { type: "context_injected", pattern: KIT },
      { type: "context_injected", pattern: "USING-THE-KIT", flags: "i" },
      { type: "context_injected", pattern: KIT, source: "hooks" },
      { type: "context_injected", pattern: "never mentioned" },
      { type: "context_injected", pattern: KIT, source: "rules" },
    ],
  });
  expect(record?.checks.map((check) => check.score)).toEqual([1, 1, 1, 0, 0]);
  expect(record?.checks[4]?.reason).toContain("reports no rule text");
});

test("an unmet precondition invalidates the run and calls no judge", async () => {
  const box = sandbox();
  script(box, "none", { turns: [[{ final: "done" }]] });
  box.write("fake/judge/replies.json", ['{"score": 1}']);
  const { ran, record } = await scoredCase(box, plainSubject(box), {
    checks: [
      { type: "output_contains", text: "done" },
      { type: "judge", rubric: "The answer is polite." },
    ],
    more: { preconditions: [{ type: "hook_fired", event: "SessionStart" }] },
  });
  expect(ran.stderr).not.toContain("error");
  expect(record?.score).toBeNull();
  expect(record?.preconditions?.map((check) => check.score)).toEqual([0]);
  expect(record?.checks.map((check) => check.score)).toEqual([1, null]);
  expect(record?.checks[1]?.reason).toBe(
    "not judged, because precondition not met: hook_fired event SessionStart",
  );
  expect(record?.judge).toBeNull();
});

test("rules are installed and recorded", async () => {
  const box = sandbox();
  installInPlaceOfClaude(reportingRules);
  box.write("fake/report-rules", "");
  script(box, "plain", { turns: [[{ final: "done" }]] });
  const subject = ruledSubject(box, { "no-sleep.md": NO_SLEEP }, "Be brief.\n");
  const { ran, record } = await scoredCase(box, subject, {
    checks: [
      { type: "context_injected", pattern: "never sleep", flags: "i" },
      {
        type: "context_injected",
        pattern: "be brief",
        flags: "i",
        source: "rules",
      },
    ],
  });
  expect(ran.status, ran.stderr).toBe(0);
  expect(record?.rules?.installed).toEqual([
    ".claude/rules/no-sleep.md",
    ".claude/CLAUDE.md",
  ]);
  expect(record?.rules?.reportedLoaded).toHaveLength(2);
  expect(record?.checks.map((check) => check.score)).toEqual([1, 1]);
});

test("a rules case on a harness without rules is not applicable", () => {
  const box = sandbox();
  box.write("cases/needs/prompt.md", "go\n");
  box.write("cases/needs/case.json", {
    requires: ["rules"],
    checks: [{ type: "output_contains", text: "x" }],
  });
  box.write("cases/pre/prompt.md", "go\n");
  box.write("cases/pre/case.json", {
    preconditions: [{ type: "context_injected", pattern: "x" }],
    checks: [{ type: "output_contains", text: "x" }],
  });
  const [needs, pre] = loadCases(path.join(box.root, "cases"));
  const bare: Harness = { ...claudeCode, capabilities: new Set(["history"]) };
  const hooksOnly: Harness = { ...bare, capabilities: new Set(["hooks"]) };
  expect(needs && applicability(bare, needs)).toMatchObject({
    applicable: false,
    missing: ["rules"],
  });
  expect(needs && applicability(claudeCode, needs).applicable).toBe(true);
  // A precondition's needs count: "any" wants hooks or rules, and a harness with neither cannot show either.
  expect(pre && applicability(bare, pre)).toMatchObject({
    applicable: false,
    missing: ["hooks", "rules"],
  });
  expect(pre && applicability(hooksOnly, pre).applicable).toBe(true);
});

test("a non-precondition check type under preconditions is a load error", () => {
  const box = sandbox();
  box.write("cases/bad/prompt.md", "go\n");
  box.write("cases/bad/case.json", {
    preconditions: [{ type: "output_contains", text: "x" }],
    checks: [{ type: "output_contains", text: "x" }],
  });
  expect(() => loadCases(path.join(box.root, "cases"))).toThrow(
    /output_contains cannot be a precondition; allowed: .*context_injected.*hook_fired.*skill_available.*skill_loaded/,
  );
});
