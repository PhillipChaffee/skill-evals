import { hookEvent } from "./hook.js";
import type { HookEvent } from "./hook.js";

/** The fields of a `hook_response` system event that the adapter reads. */
interface HookResponse {
  hook_event?: string;
  stdout?: string;
  output?: string;
  exit_code?: number;
  outcome?: string;
}

// The events whose plain standard output the CLI adds to the model's context (`M7a` in the binary).
const PLAIN_EVENTS = ["SessionStart", "UserPromptSubmit"];

/**
 * Reads the text a hook puts in front of the model.
 * @param one - The `hook_response` event.
 * @returns For any event, the `hookSpecificOutput.additionalContext` of the hook's JSON output. Plain output counts for
 *   `SessionStart` and `UserPromptSubmit` only, and only when the hook succeeded (exit 0, or outcome `success`); JSON
 *   output without that field adds nothing. Any other output is not context, so undefined.
 */
function contextOf(one: HookResponse): string | undefined {
  const raw = one.stdout ?? one.output;
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON: plain output.
  }
  if (parsed !== null && typeof parsed === "object") {
    const added = (
      parsed as { hookSpecificOutput?: { additionalContext?: unknown } }
    ).hookSpecificOutput?.additionalContext;
    return typeof added === "string" ? added : undefined;
  }
  const succeeded = one.exit_code === 0 || one.outcome === "success";
  return PLAIN_EVENTS.includes(one.hook_event ?? "") && succeeded
    ? raw
    : undefined;
}

/**
 * Makes the hook event of a `hook_response` event. The stream's schema (read from the CLI binary's strings) is
 * `{ type: "system", subtype: "hook_response", hook_id, hook_name, hook_event, output, stdout, stderr, exit_code?,
 * outcome }`. It does not carry the hook's command, so `command` is null.
 * @param one - The event.
 * @returns The hook event, with the context that `contextOf` finds.
 */
export function hookOfClaude(one: HookResponse): HookEvent {
  return hookEvent({
    event: one.hook_event ?? "",
    exit: one.exit_code,
    context: contextOf(one),
  });
}
