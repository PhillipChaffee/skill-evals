import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { script } from "./testing/plant.js";
import {
  installInPlaceOfClaude,
  plainSubject,
  reportingRules,
  ruledSubject,
  scoredCase,
  workspaceRules,
} from "./testing/rules.js";
import { sandbox } from "./testing/sandbox.js";
import { scored } from "./testing/outcome.js";
import { hook, played } from "./testing/transcript.js";
import { call } from "./testing/transcript.js";

const DONE = [{ type: "output_contains", text: "done" }];

const judgePrompts = (box: ReturnType<typeof sandbox>): number => {
  const logged = path.join(box.root, "fake/judge/prompts.jsonl");
  return fs.existsSync(logged)
    ? fs.readFileSync(logged, "utf8").trim().split("\n").length
    : 0;
};

test("a precondition next to a judge check calls no judge when it fails, and one judge when it holds", async () => {
  const unmet = sandbox();
  script(unmet, "plain", { turns: [[{ final: "done" }]] });
  unmet.write("fake/judge/replies.json", ['{"score": 1}']);
  const checks = [{ type: "judge", rubric: "The answer is polite." }];
  const more = {
    preconditions: [{ type: "context_injected", pattern: "bootstrap" }],
  };
  const first = await scoredCase(unmet, plainSubject(unmet), { checks, more });
  expect(first.records[0]?.score).toBeNull();
  expect(judgePrompts(unmet)).toBe(0);
  const met = sandbox();
  script(met, "plain", {
    turns: [
      [
        {
          hook: {
            event: "SessionStart",
            command: "b",
            exit: 0,
            context: "bootstrap",
          },
        },
        { final: "done" },
      ],
    ],
  });
  met.write("fake/judge/replies.json", ['{"score": 1}']);
  const second = await scoredCase(met, plainSubject(met), { checks, more });
  expect(second.records[0]?.score).toBe(1);
  expect(judgePrompts(met)).toBe(1);
});

test("a precondition never counts in the score", async () => {
  const box = sandbox();
  script(box, "plain", {
    turns: [
      [
        {
          hook: { event: "SessionStart", command: "b", exit: 0, context: "x" },
        },
        { final: "done" },
      ],
    ],
  });
  const { records } = await scoredCase(box, plainSubject(box), {
    checks: [{ type: "output_contains", text: "absent" }],
    more: {
      preconditions: [{ type: "hook_fired", event: "SessionStart" }],
    },
  });
  expect(records[0]?.score).toBe(0);
  expect(records[0]?.preconditions?.map((one) => one.score)).toEqual([1]);
  expect(records[0]?.checks).toHaveLength(1);
});

test("context_injected never matches text that was installed but not reported", async () => {
  const box = sandbox();
  // This harness can report rules, but its stream states none in this run, as when the rule never loaded.
  installInPlaceOfClaude(reportingRules);
  script(box, "plain", { turns: [[{ final: "done" }]] });
  const subject = ruledSubject(box, { "secret.md": "SECRETWORD lives here." });
  const { records } = await scoredCase(box, subject, {
    checks: [
      { type: "context_injected", pattern: "SECRETWORD", source: "rules" },
      { type: "context_injected", pattern: "SECRETWORD" },
    ],
  });
  const [record] = records;
  // The adapter installed the file, and its stream reports no rule, so the text that the file holds is not evidence.
  expect(record?.rules?.installed).toEqual(["home/.claude/rules/secret.md"]);
  expect(record?.rules?.reportedLoaded).toBeNull();
  expect(record?.checks.map((check) => check.score)).toEqual([0, 0]);
});

test("context_injected reads a rule text that the harness reported", async () => {
  const box = sandbox();
  installInPlaceOfClaude(reportingRules);
  box.write("fake/report-rules", "");
  script(box, "plain", { turns: [[{ final: "done" }]] });
  const { records } = await scoredCase(
    box,
    ruledSubject(box, { "secret.md": "SECRETWORD lives here." }),
    {
      checks: [
        { type: "context_injected", pattern: "SECRETWORD", source: "rules" },
      ],
    },
  );
  expect(records[0]?.checks.map((check) => check.score)).toEqual([1]);
});

test("a rule that would land on a file of the case is a load error naming both", async () => {
  const box = sandbox();
  installInPlaceOfClaude(workspaceRules);
  script(box, "plain", { turns: [[{ final: "done" }]] });
  const subject = ruledSubject(box, { "no-sleep.md": "Never sleep." });
  box.write("cases/restate/workspace/.agent-rules/no-sleep.md", "mine\n");
  const { ran } = await scoredCase(box, subject, { checks: DONE });
  expect(ran.status).toBe(2);
  expect(ran.stderr).toMatch(
    /case restate: .*\.agent-rules\/no-sleep\.md clashes with the rule no-sleep\.md of .*skills.*workspace\/\.agent-rules\/no-sleep\.md/,
  );
});

test("a rules path that leaves the subject, or is a link, is refused", async () => {
  const box = sandbox();
  script(box, "plain", { turns: [[{ final: "done" }]] });
  const subject = plainSubject(box);
  box.write("skill-evals.config.json", { rules: "../elsewhere" });
  const outside = await scoredCase(box, subject, { checks: DONE });
  expect(outside.ran.status).toBe(2);
  expect(outside.ran.stderr).toContain(
    '"rules" ../elsewhere must be a path inside the subject',
  );
  box.write("skill-evals.config.json", { instructionFile: "missing.md" });
  const missing = await scoredCase(box, subject, { checks: DONE });
  expect(missing.ran.stderr).toContain(
    '"instructionFile" missing.md is not in the subject',
  );
});

test("hook_fired counts the hooks of its event between min and max", () => {
  const twice = played(
    hook("SessionStart", { context: "a" }),
    hook("Stop", { exit: 0 }),
    hook("SessionStart", { context: "b" }),
  );
  const fired = (fields: Record<string, unknown>) =>
    scored({ type: "hook_fired", event: "SessionStart", ...fields }, twice)
      .score;
  expect(fired({})).toBe(1);
  expect(fired({ min: 2 })).toBe(1);
  expect(fired({ min: 3 })).toBe(0);
  expect(fired({ max: 1 })).toBe(0);
  expect(fired({ min: 1, max: 2 })).toBe(1);
  expect(fired({ event: "Other", max: 0 })).toBe(1);
  expect(fired({ event: "Other" })).toBe(0);
  const wrong = scored({ type: "hook_fired", event: "Other" }, twice);
  expect(wrong.reason).toContain(
    "0 Other hooks ran, not 1 or more (hooks that ran: SessionStart, Stop)",
  );
});

test("a hook event does not satisfy tool_called", () => {
  const outcome = played(hook("PreToolUse", { context: "x" }));
  expect(outcome.toolCalls).toEqual([]);
  expect(
    scored({ type: "tool_called", name: "PreToolUse" }, outcome).score,
  ).toBe(0);
  expect(scored({ type: "tool_called", max: 0 }, outcome).score).toBe(1);
  const mixed = played(call("Bash", { command: "ls" }, "a"), hook("Stop"));
  expect(mixed.toolCalls.map((one) => one.name)).toEqual(["Bash"]);
});

test("context_injected says which source it tested when it finds nothing", () => {
  const ran = played(hook("SessionStart", { context: "a" }));
  const reason = (source: "hooks" | "rules" | "any") =>
    scored({ type: "context_injected", pattern: "zzz", source }, ran).reason;
  expect(reason("hooks")).toBe(
    "no hook context matches /zzz/ in 1 tested text",
  );
  expect(reason("rules")).toBe(
    "no reported rule text matches /zzz/ in 0 tested texts; the harness reports no rule text",
  );
  expect(reason("any")).toBe(
    "no hook context or reported rule text matches /zzz/ in 1 tested text; the harness reports no rule text",
  );
});

test("a rule whose place is taken when the run starts makes the run invalid, with the reason", async () => {
  const box = sandbox();
  installInPlaceOfClaude(workspaceRules);
  script(box, "plain", { turns: [[{ final: "done" }]] });
  const subject = ruledSubject(box, { "no-sleep.md": "Never sleep." });
  // A setup step runs after the load, so only the install can see this file.
  const { records } = await scoredCase(box, subject, {
    checks: DONE,
    more: {
      setup: [
        {
          run: "node -e \"const fs=require('node:fs');fs.mkdirSync('.agent-rules');fs.writeFileSync('.agent-rules/no-sleep.md','mine')\"",
        },
      ],
    },
  });
  expect(records[0]?.score).toBeNull();
  expect(records[0]?.error).toBe(
    "could not install the rules for claude-code: .agent-rules/no-sleep.md already exists in the workspace",
  );
});
