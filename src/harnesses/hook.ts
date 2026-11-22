/** The most characters of a hook's context that a run keeps; the rest is cut and the cut is stated. */
export const HOOK_CONTEXT_CAP = 4000;

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
  /** The text the hook put in front of the model, cut to `HOOK_CONTEXT_CAP` characters; null when it produced none. */
  context: string | null;
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
  const cut = has && context.length > HOOK_CONTEXT_CAP;
  return {
    event: given.event,
    command: given.command ?? null,
    exit: given.exit ?? null,
    contextBytes: has ? Buffer.byteLength(context) : null,
    context: !has
      ? null
      : cut
        ? `${context.slice(0, HOOK_CONTEXT_CAP)}\n[cut: the first ${String(HOOK_CONTEXT_CAP)} of ${String(context.length)} characters are kept]`
        : context,
  };
}
