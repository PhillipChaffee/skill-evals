/** The most characters of one event's input, output or text, or of one line of a reason, that `show` prints. */
export const SHOW_CUT = 200;
const HEX = 16;
const HEX_DIGITS = 2;
const HEX_UNIT = 4;
const MAX_BYTE = 0xff;

// One unit that a cut keeps whole: an escape that `clean` or JSON wrote, or one code point (a surrogate pair is one).
const UNIT = /\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}|\\[\s\S]|[\s\S]/gu;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Makes text safe to print on one terminal line.
 * @param text - Any string that came from a file, the command line or an agent.
 * @returns The text with each control character (`\x00` to `\x1f`, `\x7f` to `\x9f`, newline included) written as `\xNN`, and each bidirectional control (U+202A to U+202E, U+2066 to U+2069) as `\uNNNN`, so
 *   that nothing in it can move the cursor, start an escape sequence or begin another line.
 */
export const clean = (text: string): string =>
  text.replace(CONTROL, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= MAX_BYTE
      ? `\\x${code.toString(HEX).padStart(HEX_DIGITS, "0")}`
      : `\\u${code.toString(HEX).padStart(HEX_UNIT, "0")}`;
  });

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
 * @returns The value as JSON, cleaned, so that it is quoted and has no control character, and cut like any text; `missing` when absent.
 */
export const quoted = (value: string | undefined, missing: string): string =>
  value === undefined ? missing : shown(JSON.stringify(value));
