/** The most characters of a hook's context that the transcript file keeps; the rest is cut and the cut is stated. */
export const HOOK_CONTEXT_CAP = 64_000;
/** The most characters of a hook's context that records, `show` and reports display. */
export const HOOK_DISPLAY_CAP = 4000;

/** One hook that ran, as a harness's stream states it. A field the stream does not carry is null. */
export interface HookEvent {
  /** The hook's event, such as `SessionStart`. */
  event: string;
  /** The command the hook ran; null where the stream does not carry it. */
  command: string | null;
  /** The command's exit code; null where the stream states none. */
  exit: number | null;
  /** The UTF-8 size of the context before any cut; null when the hook produced no context. */
  contextBytes: number | null;
  /**
   * The text the hook put in front of the model: cut to `HOOK_CONTEXT_CAP` characters in the transcript file, which
   * `context_injected` reads, and to `HOOK_DISPLAY_CAP` where records, `show` and reports display it; null when the
   * hook produced none.
   */
  context: string | null;
}

/**
 * Cuts a text to a number of characters and says so.
 * @param text - What to cut.
 * @param cap - The most characters to keep.
 * @returns The text as it is when it fits; else its first `cap` characters and a line that says how many were kept.
 */
function cutTo(text: string, cap: number): string {
  return text.length <= cap
    ? text
    : `${text.slice(0, cap)}\n[cut: the first ${String(cap)} of ${String(text.length)} characters are kept]`;
}

/**
 * Makes the hook event of a hook's own words.
 * @param given - What the stream states of the hook.
 * @param given.event - The hook's event name, as the harness spells it.
 * @param given.command - The command, when the stream has it.
 * @param given.exit - The exit code, when the stream has it.
 * @param given.context - What the hook put in front of the model; empty or absent for none.
 * @returns The event. A context longer than `HOOK_CONTEXT_CAP` characters is cut there, with a line that says how many
 *   characters were kept, and `contextBytes` keeps the size before the cut.
 */
export function hookEvent(given: {
  event: string;
  command?: string | null | undefined;
  exit?: number | null | undefined;
  context?: string | null | undefined;
}): HookEvent {
  const { context } = given;
  const has = context !== undefined && context !== null && context !== "";
  return {
    event: given.event,
    command: given.command ?? null,
    exit: given.exit ?? null,
    contextBytes: has ? Buffer.byteLength(context) : null,
    context: has ? cutTo(context, HOOK_CONTEXT_CAP) : null,
  };
}

/**
 * Cuts a hook event for display.
 * @param hook - A hook event as the transcript file holds it.
 * @returns The event with its context cut to `HOOK_DISPLAY_CAP` characters and the cut stated; the same event when it fits.
 */
export function shownHook(hook: HookEvent): HookEvent {
  const { context } = hook;
  if (context === null || context.length <= HOOK_DISPLAY_CAP) return hook;
  // A context that the file cut already ends in its own line; the display cut comes first.
  return { ...hook, context: cutTo(context, HOOK_DISPLAY_CAP) };
}
