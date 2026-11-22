// What XML 1.0 allows in text: tab, line feed, carriage return, and these ranges. The class is negated, so a lone
// surrogate, U+FFFE and U+FFFF match too.
const FORBIDDEN = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  // A reader normalises a literal line break in an attribute to a space, so each is written as a reference.
  "\n": "&#10;",
  "\r": "&#13;",
  "\t": "&#9;",
};

/**
 * Makes text safe for an XML or HTML text node or attribute value.
 * @param text - Any text, such as a case id or an error message from a harness.
 * @returns The text with `&`, `<`, `>`, both quotes and line breaks and tabs escaped, and every character that XML 1.0 does not allow removed:
 *   control characters other than tab, line feed and carriage return, lone surrogates, and U+FFFE and U+FFFF.
 */
export const escapeXml = (text: string): string =>
  text
    .replace(FORBIDDEN, "")
    .replace(/[&<>"'\n\r\t]/g, (char) => ENTITIES[char] ?? char);
