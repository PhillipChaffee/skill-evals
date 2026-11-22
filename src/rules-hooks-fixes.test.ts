import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { applicability, partitionApplicable } from "./applicability.js";
import { loadCases } from "./cases.js";
import claudeCode from "./harnesses/claude-code.js";
import { NOT_REPORTED } from "./harnesses/shared.js";
import { runKey } from "./run-key.js";
import type { RunPlan } from "./run-plan.js";
import { unionLoaded } from "./turn-merge.js";
import { script } from "./testing/plant.js";
import {
  installInPlaceOfClaude,
  plainSubject,
  reportingRules,
  ruledSubject,
  scoredCase,
  workspaceRules,
} from "./testing/rules.js";
import { readResults, sandbox } from "./testing/sandbox.js";

const NEVER = "Never sleep.";
const SCORE = "score";
const PRE = "cases/pre/case.json";
const CLAUDE = { id: "claude-code" };
const DONE = [{ type: "output_contains", text: "done" }];
const SCRIPT = { turns: [[{ final: "done" }]] };

test("the texts of the rules that each process of a run reported are joined", async () => {
  expect(
    unionLoaded([
      { ...NOT_REPORTED, ruleTexts: ["a"] },
      { ...NOT_REPORTED, ruleTexts: ["b", "a"] },
    ]).ruleTexts,
  ).toEqual(["a", "b"]);
  expect(unionLoaded([NOT_REPORTED, NOT_REPORTED])).not.toHaveProperty(
    "ruleTexts",
  );
  // A case with two turns: the record's report, and so the check, holds the texts that the processes stated.
  const box = sandbox();
  installInPlaceOfClaude(reportingRules);
  box.write("fake/report-rules", "");
  script(box, "talk", {
    turns: [[{ text: "one" }], [{ text: "two" }]],
  });
  box.write("cases/talk/one.md", "first\n");
  box.write("cases/talk/two.md", "second\n");
  box.write("cases/talk/case.json", {
    turns: [{ prompt: "one.md" }, { prompt: "two.md" }],
    checks: [
      {
        type: "context_injected",
        pattern: "never sleep",
        flags: "i",
        source: "rules",
      },
    ],
  });
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    ...[SCORE, "--subject", ruledSubject(box, { "r.md": NEVER })],
    ...["--cases", path.join(box.root, "cases"), "--reps", "1", "--out", out],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  expect(readResults(out).records[0]?.checks[0]?.score).toBe(1);
});

test("validate reports a rules clash as a problem for an installed harness", async () => {
  const box = sandbox();
  installInPlaceOfClaude(workspaceRules);
  script(box, "plain", SCRIPT);
  const subject = ruledSubject(box, { "no-sleep.md": NEVER });
  box.write("cases/restate/prompt.md", "go\n");
  box.write("cases/restate/case.json", { checks: DONE });
  box.write("cases/restate/workspace/.agent-rules/no-sleep.md", "mine\n");
  const out = await box.cli([
    ...["validate", "--cases", path.join(box.root, "cases")],
    ...["--subject", subject],
  ]);
  expect(out.status).toBe(2);
  expect(out.stdout).toMatch(
    /problem restate: .*\.agent-rules\/no-sleep\.md clashes with the rule no-sleep\.md/,
  );
  expect(out.stdout).toContain("rename or remove that file of the case");
});

test("a case file under the directory that rules are installed into is a clash, and so is the instruction file's place", async () => {
  const box = sandbox();
  script(box, "plain", SCRIPT);
  const subject = ruledSubject(box, { "no-sleep.md": NEVER }, "Be brief.\n");
  box.write("cases/restate/prompt.md", "go\n");
  box.write("cases/restate/case.json", { checks: DONE, home: "home" });
  box.write("cases/restate/home/.claude/rules/other.md", "mine\n");
  const first = await box.cli([
    ...[
      "validate",
      "--cases",
      path.join(box.root, "cases"),
      "--subject",
      subject,
    ],
  ]);
  expect(first.stdout).toContain("home/.claude/rules/other.md");
  expect(first.status).toBe(2);
  fs.rmSync(path.join(box.root, "cases/restate/home"), { recursive: true });
  box.write("cases/restate/home/.claude/CLAUDE.md", "mine\n");
  const second = await box.cli([
    ...[
      "validate",
      "--cases",
      path.join(box.root, "cases"),
      "--subject",
      subject,
    ],
  ]);
  expect(second.stdout).toMatch(/CLAUDE\.md clashes with the rule AGENTS\.md/);
});

test("the run key carries rules and the command line's revision only where they are set", () => {
  const plan = (more: Record<string, unknown>) => {
    const box = sandbox();
    box.write("cases/solo/prompt.md", "go\n");
    box.write("cases/solo/case.json", { checks: DONE });
    const [caseDef] = loadCases(path.join(box.root, "cases"));
    return {
      caseDef,
      subject: { revision: "rev-1", rules: null },
      harness: CLAUDE,
      bin: "/nonexistent/claude",
      rep: 1,
      judge: { harness: CLAUDE, bin: "/nonexistent/claude" },
      ...more,
    } as unknown as RunPlan;
  };
  const base = runKey(plan({}));
  const ruled = (rules: unknown) =>
    runKey(plan({ subject: { revision: "rev-1", rules } }));
  expect(ruled({ dir: "rules", instructionFile: null })).not.toBe(base);
  expect(ruled({ dir: "rules", instructionFile: null })).not.toBe(
    ruled({ dir: null, instructionFile: "AGENTS.md" }),
  );
  expect(runKey(plan({ harness: { ...CLAUDE, argvRevision: 1 } }))).toBe(base);
  expect(runKey(plan({ harness: { ...CLAUDE, argvRevision: 2 } }))).not.toBe(
    base,
  );
});

test("a precondition takes no weight and no ifUnsupported, and a count of at least 0 with no max is refused", () => {
  const box = sandbox();
  const loads = (file: Record<string, unknown>): string => {
    box.write("cases/bad/prompt.md", "go\n");
    box.write("cases/bad/case.json", { checks: DONE, ...file });
    try {
      loadCases(path.join(box.root, "cases"));
      return "";
    } catch (error) {
      return String(error instanceof Error ? error.message : error);
    }
  };
  const pre = { type: "hook_fired", event: "SessionStart" };
  expect(loads({ preconditions: [{ ...pre, weight: 2 }] })).toMatch(
    /a precondition takes no "weight"/,
  );
  expect(loads({ preconditions: [{ ...pre, ifUnsupported: "skip" }] })).toMatch(
    /a precondition takes no "ifUnsupported"/,
  );
  expect(loads({ preconditions: [{ ...pre, min: 0 }] })).toMatch(
    /"min" 0 with no "max"/,
  );
  expect(
    loads({ checks: [{ type: "tool_called", kind: "shell", min: 0 }] }),
  ).toMatch(/"min" 0 with no "max" passes every run/);
  expect(
    loads({ checks: [{ type: "tool_called", kind: "shell", min: 0, max: 2 }] }),
  ).toBe("");
  expect(
    loads({ preconditions: [{ type: "skill_loaded", skill: "s" }] }),
  ).toMatch(
    /skill_loaded cannot be a precondition; allowed: context_injected, hook_fired, skill_available/,
  );
});

test("an instruction file inside the rules directory is refused, and only .md files of it are installed", async () => {
  const box = sandbox();
  script(box, "plain", SCRIPT);
  const subject = ruledSubject(box, {
    "a.md": "A",
    "notes.txt": "N",
    "sub/b.md": "B",
  });
  box.write("skill-evals.config.json", {
    rules: "rules",
    instructionFile: "rules/a.md",
  });
  const refused = await scoredCase(box, subject, { checks: DONE });
  expect(refused.ran.status).toBe(2);
  expect(refused.ran.stderr).toContain("inside the rules directory rules");
  box.write("skill-evals.config.json", { rules: "rules" });
  const { ran, record } = await scoredCase(box, subject, { checks: DONE });
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stderr).toContain(
    'only .md files of "rules" are installed; not installed: notes.txt',
  );
  expect(record?.rules?.installed).toEqual([
    "home/.claude/rules/a.md",
    "home/.claude/rules/sub/b.md",
  ]);
});

test("a skipped context_injected names the one-of group, and explain and show print preconditions", async () => {
  const box = sandbox();
  box.write("cases/pre/prompt.md", "go\n");
  box.write(PRE, {
    preconditions: [{ type: "context_injected", pattern: "x" }],
    checks: [
      DONE[0],
      { type: "context_injected", pattern: "y", ifUnsupported: "skip" },
    ],
  });
  const cases = loadCases(path.join(box.root, "cases"));
  const bare = { ...claudeCode, capabilities: new Set<never>() };
  const [first] = cases;
  expect(first && applicability(bare, first)).toMatchObject({
    reason: "needs one of hooks, rulesReport",
  });
  box.write(PRE, {
    checks: [
      DONE[0],
      { type: "context_injected", pattern: "y", ifUnsupported: "skip" },
    ],
  });
  const again = partitionApplicable(
    [{ harness: bare }],
    loadCases(path.join(box.root, "cases")),
  );
  expect(again.skippedChecks[0]?.missing).toEqual(["hooks", "rulesReport"]);
  box.write(PRE, {
    preconditions: [{ type: "context_injected", pattern: "x" }],
    checks: DONE,
  });
  const explained = await box.cli([
    "explain",
    "pre",
    "--cases",
    path.join(box.root, "cases"),
  ]);
  expect(explained.stdout).toContain('"preconditions"');
  expect(explained.stdout).toContain('"source": "any"');
  // A run whose precondition fails is shown with its preconditions.
  script(box, "plain", SCRIPT);
  const out = path.join(box.root, "results");
  await box.cli([
    ...[SCORE, "--subject", plainSubject(box)],
    ...["--cases", path.join(box.root, "cases"), "--reps", "1", "--out", out],
  ]);
  const shown = await box.cli(["show", out, "pre"]);
  expect(shown.stdout).toMatch(
    /preconditions\n1\. context_injected \/x\/: 0\.00/,
  );
});
