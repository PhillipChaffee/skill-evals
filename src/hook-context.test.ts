import { expect, test } from "vitest";
import claudeCode from "./harnesses/claude-code.js";
import { HOOK_CONTEXT_CAP, HOOK_DISPLAY_CAP } from "./harnesses/hook.js";
import type { HookEvent } from "./harnesses/hook.js";
import { forRecord, hookPart } from "./transcript.js";
import { scored } from "./testing/outcome.js";
import { hook, played } from "./testing/transcript.js";

/**
 * Parses a stream of hook responses.
 * @param responses - The `hook_response` events, without their type.
 * @returns The hook events of the transcript, in order.
 */
function hooksOf(responses: Record<string, unknown>[]): HookEvent[] {
  const stream = [
    ...responses.map((one) => ({
      type: "system",
      subtype: "hook_response",
      ...one,
    })),
    { type: "result", subtype: "success", result: "done" },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  return claudeCode
    .parse(stream)
    .transcript.flatMap((one) => (one.hook ? [one.hook] : []));
}

const PLAIN = "HOOKTEXT";
const ok = { exit_code: 0, outcome: "success" };

test("plain output of a hook is context only for SessionStart and UserPromptSubmit, and only when the hook succeeded", () => {
  const hooks = hooksOf([
    { hook_event: "SessionStart", stdout: PLAIN, ...ok },
    { hook_event: "UserPromptSubmit", stdout: PLAIN, ...ok },
    { hook_event: "PreToolUse", stdout: PLAIN, ...ok },
    { hook_event: "Stop", stdout: PLAIN, ...ok },
    { hook_event: "SessionStart", stdout: PLAIN, exit_code: 2 },
    { hook_event: "SessionStart", stdout: PLAIN, outcome: "error" },
    { hook_event: "SessionStart", output: PLAIN, outcome: "success" },
  ]);
  expect(hooks.map((one) => one.context)).toEqual([
    PLAIN,
    PLAIN,
    null,
    null,
    null,
    null,
    PLAIN,
  ]);
  // A hook of another event that prints text does not satisfy a check of hook context.
  const outcome = played(
    hook("PreToolUse", { context: hooks[2]?.context ?? null }),
  );
  expect(
    scored(
      { type: "context_injected", pattern: PLAIN, source: "hooks" },
      outcome,
    ).score,
  ).toBe(0);
});

test("additionalContext counts for any event, and JSON output without it adds nothing", () => {
  const added = (event: string, text: string) =>
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: text },
    });
  const hooks = hooksOf([
    {
      hook_event: "PreToolUse",
      stdout: added("PreToolUse", "From the hook."),
      exit_code: 0,
    },
    { hook_event: "SessionStart", stdout: '{"x":1}', ...ok },
    { hook_event: "SessionStart", stdout: "null", ...ok },
    { hook_event: "SessionStart", stdout: "  ", ...ok },
    { hook_event: "Stop" },
    { stdout: PLAIN, ...ok },
  ]);
  expect(hooks.map((one) => [one.event, one.exit, one.context])).toEqual([
    ["PreToolUse", 0, "From the hook."],
    ["SessionStart", 0, null],
    ["SessionStart", 0, "null"],
    ["SessionStart", 0, null],
    ["Stop", null, null],
    ["", 0, null],
  ]);
  expect(hooks[0]?.contextBytes).toBe(14);
});

test("the transcript file keeps 64,000 characters of a context and context_injected reads them; records show 4,000", () => {
  const long = `${"x".repeat(10_000)}NEEDLE${"y".repeat(HOOK_CONTEXT_CAP)}`;
  const [kept] = hooksOf([{ hook_event: "SessionStart", stdout: long, ...ok }]);
  expect(kept?.contextBytes).toBe(long.length);
  expect(kept?.context).toBe(
    `${long.slice(0, HOOK_CONTEXT_CAP)}\n[cut: the first ${String(HOOK_CONTEXT_CAP)} of ${String(long.length)} characters are kept]`,
  );
  const outcome = played(hookPart(kept as HookEvent));
  expect(
    scored({ type: "context_injected", pattern: "NEEDLE" }, outcome).score,
  ).toBe(1);
  // What a record, `show` and a report display is cut at 4,000, and says so.
  const [shown] = forRecord(outcome.transcript);
  expect(shown?.hook?.context?.startsWith("x".repeat(HOOK_DISPLAY_CAP))).toBe(
    true,
  );
  expect(shown?.hook?.context).toContain(
    `[cut: the first ${String(HOOK_DISPLAY_CAP)} of`,
  );
  expect(shown?.hook?.contextBytes).toBe(long.length);
  expect(outcome.transcript[0]?.hook?.context).toBe(kept?.context);
});

test("the Claude Code command line asks for hook events", () => {
  const { args } = claudeCode.invocation({
    subject: null,
    home: "/h",
    workspace: "/w",
    prompt: "p",
    turn: { index: 0, message: "p", invoke: null, event: null },
    session: null,
  });
  expect(args).toContain("--include-hook-events");
  expect(claudeCode.argvRevision).toBeGreaterThan(1);
});
