/** The most characters of one event's input, output or text, or of one line of a reason, that `show` prints. */
export const SHOW_CUT = 200;
const HEX = 16;
const HEX_DIGITS = 2;

// One unit that a cut keeps whole: an escape that `clean` or JSON wrote, or one code point (a surrogate pair is one).
const UNIT = /\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}|\\[\s\S]|[\s\S]/gu;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * Makes text safe to print on one terminal line.
 * @param text - Any string that came from a file, the command line or an agent.
 * @returns The text with each control character (`\x00` to `\x1f` and `\x7f`, newline included) written as `\xNN`, so
 *   that nothing in it can move the cursor, start an escape sequence or begin another line.
 */
export const clean = (text: string): string =>
  text.replace(
    CONTROL,
    (char) =>
      `\\x${(char.codePointAt(0) ?? 0).toString(HEX).padStart(HEX_DIGITS, "0")}`,
  );

/**
 * Cleans a string and cuts it where it is long.
 * @param text - Any string.
 * @returns The cleaned text, whole when it has at most `SHOW_CUT` characters; otherwise its first `SHOW_CUT`
 *   characters or fewer, never ending inside an escape or a surrogate pair, then `[cut at 200 of <n> characters]`,
 *   where n is the length of the cleaned text.
 */
export function shown(text: string): string {
  const safe = clean(text);
  if (safe.length <= SHOW_CUT) return safe;
  let kept = "";
  for (const unit of safe.match(UNIT) ?? []) {
    if (kept.length + unit.length > SHOW_CUT) break;
    kept += unit;
  }
  return `${kept} [cut at ${String(SHOW_CUT)} of ${String(safe.length)} characters]`;
}

/**
 * Writes a name, a kind or an agent id.
 * @param value - The string, or undefined for a field the event lacks.
 * @param missing - What to print when there is none.
 * @returns The value as JSON, cleaned, so that it is quoted and has no control character; `missing` when absent.
 */
export const quoted = (value: string | undefined, missing: string): string =>
  value === undefined ? missing : clean(JSON.stringify(value));
