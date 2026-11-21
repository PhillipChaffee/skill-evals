/**
 * Counts the lines of a text. A final line break ends a line and does not start another.
 * @param text - Any text.
 * @returns 0 for an empty text, else the number of lines.
 */
export function countLines(text: string): number {
  if (text === "") return 0;
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

/**
 * Finds the longest string in a value, searching objects and arrays at any depth.
 * @param value - Any JSON value.
 * @returns The longest string, the first of equal length; the empty string when the value holds none.
 */
export function longestString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return "";
  let longest = "";
  for (const inner of Object.values(value)) {
    const found = longestString(inner);
    if (found.length > longest.length) longest = found;
  }
  return longest;
}
