/** One element of a parsed XML document. */
export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** The text directly inside the element, entities decoded. */
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
};

// What XML 1.0 allows in text.
const ALLOWED = /^[\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u;
const TOKEN = /<(\/?)([\w-]+)((?:\s+[\w-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([\w-]+)="([^"]*)"/g;

/**
 * Decodes the entities of a piece of text.
 * @param text - Text that holds no bare ampersand.
 * @returns The text.
 * @throws {Error} For an entity that XML does not predefine.
 */
const decode = (text: string): string =>
  text.replace(/&(#?\w+);/g, (whole, name: string) => {
    const code = /^#(\d+)$/.exec(name)?.[1];
    const known =
      code === undefined ? ENTITIES[name] : String.fromCodePoint(Number(code));
    if (known === undefined) throw new Error(`unknown entity ${whole}`);
    return known;
  });

/**
 * Reads the attributes of a start tag.
 * @param raw - The text between the tag's name and its end.
 * @returns The attributes, decoded.
 */
const attributesOf = (raw: string): Record<string, string> =>
  Object.fromEntries(
    [...raw.matchAll(ATTRIBUTE)].map((found) => [
      found[1] ?? "",
      decode(found[2] ?? ""),
    ]),
  );

/**
 * Applies one token of the document to the stack of open elements.
 * @param stack - The open elements; the last is the one the token is inside.
 * @param match - A match of `TOKEN`: a start or end tag, or text.
 * @throws {Error} For a bare ampersand, an unknown entity, or an end tag that closes another element.
 */
function apply(stack: XmlElement[], match: RegExpMatchArray): void {
  const top = stack.at(-1) as XmlElement;
  const [, closing, name = "", attributes = "", selfClosing, text] = match;
  if (text !== undefined) {
    if (/&(?!#?\w+;)/.test(text)) throw new Error(`bad text ${text}`);
    top.text += decode(text);
  } else if (closing) {
    if (top.name !== name) throw new Error(`</${name}> closes <${top.name}>`);
    stack.pop();
  } else {
    const element = {
      name,
      attributes: attributesOf(attributes),
      children: [],
      text: "",
    };
    top.children.push(element);
    if (!selfClosing) stack.push(element);
  }
}

/**
 * Parses a document of elements, attributes and text: the subset that a JUnit report uses. It is strict where a lax
 * reader is not: it rejects a character that XML 1.0 forbids, a bare `&` or `<`, and a tag that does not match.
 * @param xml - The document, with an optional declaration.
 * @returns The root element.
 * @throws {Error} When the text is not well formed.
 */
export function parseXml(xml: string): XmlElement {
  if (!ALLOWED.test(xml)) throw new Error("a character that XML forbids");
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const root: XmlElement = { name: "", attributes: {}, children: [], text: "" };
  const stack = [root];
  let end = 0;
  for (const match of body.matchAll(TOKEN)) {
    if (match.index !== end) throw new Error(`bad markup at ${String(end)}`);
    end = match.index + match[0].length;
    apply(stack, match);
  }
  const [only] = root.children;
  if (end !== body.length || stack.length !== 1 || only === undefined) {
    throw new Error("not well formed");
  }
  return only;
}

/**
 * Finds a testcase of a JUnit report by its name.
 * @param root - The `testsuites` element.
 * @param name - The testcase's `name`.
 * @returns The first testcase of that name in any testsuite, or undefined.
 */
export const testNamed = (
  root: XmlElement,
  name: string,
): XmlElement | undefined =>
  root.children
    .flatMap((suite) => suite.children)
    .find((each) => each.attributes["name"] === name);
