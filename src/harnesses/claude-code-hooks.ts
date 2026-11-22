import { hookEvent } from "./hook.js";
import type { HookEvent } from "./hook.js";

/** The fields of a `hook_response` system event that the adapter reads. */
interface HookResponse {
  hook_event?: string;
  stdout?: string;
  output?: string;
  exit_code?: number;
}

/**
 * Reads the text a hook puts in front of the model from its standard output. A hook that prints JSON with
 * `hookSpecificOutput.additionalContext` adds that text; any other output is added as it is.
 * @param stdout - What the hook wrote.
 * @returns The context; undefined for an empty output.
 */
function contextOf(stdout: string | undefined): string | undefined {
  if (stdout === undefined || stdout.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(stdout);
    const added = (
      parsed as { hookSpecificOutput?: { additionalContext?: unknown } } | null
    )?.hookSpecificOutput?.additionalContext;
    if (typeof added === "string") return added;
  } catch {
    // Not JSON: the text is the context.
  }
  return stdout;
}

/**
 * Makes the hook event of a `hook_response` event. The stream's schema (read from the CLI binary's strings) is
 * `{ type: "system", subtype: "hook_response", hook_id, hook_name, hook_event, output, stdout, stderr, exit_code?,
 * outcome }`. It does not carry the hook's command, so `command` is null.
 * @param one - The event.
 * @returns The hook event; its context is the `additionalContext` of the hook's JSON output, else its standard output.
 */
export function hookOfClaude(one: HookResponse): HookEvent {
  return hookEvent({
    event: one.hook_event ?? "",
    exit: one.exit_code,
    context: contextOf(one.stdout ?? one.output),
  });
}
