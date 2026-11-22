const PAIR = 2;
const OPERATORS = new Set([";", "|", "\n"]);
const ESCAPABLE_IN_QUOTES = new Set(['"', "\\", "$", "`"]);
// `<<` or `<<-` and a delimiter word, but not the `<<<` of a here-string.
const HEREDOC = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/;
const HOME_REFERENCE = /^\$(?:HOME\b|\{HOME\})/;

/** What the splitter has read so far. */
interface Reading {
  segments: string[][];
  words: string[];
  word: string;
  /** Whether the word is started: `''` is an empty word, so an empty `word` is not enough. */
  started: boolean;
}

/**
 * Ends the word being read.
 * @param reading - The state, changed in place.
 */
function endWord(reading: Reading): void {
  if (reading.started) reading.words.push(reading.word);
  reading.word = "";
  reading.started = false;
}

/**
 * Ends the command being read.
 * @param reading - The state, changed in place.
 */
function endSegment(reading: Reading): void {
  endWord(reading);
  if (reading.words.length > 0) reading.segments.push(reading.words);
  reading.words = [];
}

/**
 * Finds a reference to the home directory at a position.
 * @param text - The text being read.
 * @param at - A position in it.
 * @returns How many characters `$HOME` or `${HOME}` takes there; 0 when none starts there.
 */
const homeLength = (text: string, at: number): number =>
  HOME_REFERENCE.exec(text.slice(at))?.[0].length ?? 0;

/**
 * Reads the text of a quoted word.
 * @param command - The whole command.
 * @param start - The position of the opening quote.
 * @param home - What `$HOME` is inside double quotes; undefined leaves it as it is.
 * @returns The unquoted text, and the position after the closing quote (the end when it never closes).
 */
function quoted(
  command: string,
  start: number,
  home: string | undefined,
): { text: string; end: number } {
  const quote = command.charAt(start);
  let text = "";
  let at = start + 1;
  while (at < command.length && command.charAt(at) !== quote) {
    const char = command.charAt(at);
    const next = command.charAt(at + 1);
    const reference = quote === '"' && home !== undefined && char === "$";
    if (quote === '"' && char === "\\" && next === "\n") {
      at += PAIR;
    } else if (
      quote === '"' &&
      char === "\\" &&
      ESCAPABLE_IN_QUOTES.has(next)
    ) {
      text += next;
      at += PAIR;
    } else if (reference && homeLength(command, at) > 0) {
      text += home;
      at += homeLength(command, at);
    } else {
      text += char;
      at += 1;
    }
  }
  return { text, end: at + 1 };
}

/**
 * Drops the bodies of here-documents, which are text and not commands.
 * @param command - The text of a shell call.
 * @returns The command with each body, and the line that ends it, removed.
 */
function withoutHeredocs(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? "";
    kept.push(line);
    const delimiter = HEREDOC.exec(line)?.[3];
    if (delimiter === undefined) continue;
    const end = lines.findIndex(
      (later, index) => index > at && later.trim() === delimiter,
    );
    at = end < 0 ? lines.length : end;
  }
  return kept.join("\n");
}

/**
 * Reads one piece of the text at a position.
 * @param text - The command.
 * @param at - A position in it.
 * @param context - Where the word is, and what `$HOME` is.
 * @param context.home - The home directory; undefined expands nothing.
 * @param context.started - Whether the current word has begun, which decides if a `~` starts it.
 * @returns The characters to add to the word (null adds none), how many characters the piece took, and whether it ends
 *   a word or a command.
 */
function piece(
  text: string,
  at: number,
  context: { home: string | undefined; started: boolean },
): { add: string | null; width: number; ends: "word" | "command" | null } {
  const char = text.charAt(at);
  const next = text.charAt(at + 1);
  const { home } = context;
  if (char === "'" || char === '"') {
    const read = quoted(text, at, home);
    return { add: read.text, width: read.end - at, ends: null };
  }
  if (char === "\\" && next === "\n")
    return { add: null, width: PAIR, ends: null };
  if (char === "\\" && next !== "")
    return { add: next, width: PAIR, ends: null };
  if (OPERATORS.has(char)) return { add: null, width: 1, ends: "command" };
  if (char === "&" && next === "&")
    return { add: null, width: PAIR, ends: "command" };
  if (/\s/.test(char)) return { add: null, width: 1, ends: "word" };
  if (home !== undefined && char === "$" && homeLength(text, at) > 0) {
    return { add: home, width: homeLength(text, at), ends: null };
  }
  const tilde =
    home !== undefined &&
    char === "~" &&
    !context.started &&
    (next === "/" || next === "" || /\s/.test(next));
  return { add: tilde ? home : char, width: 1, ends: null };
}

/**
 * Splits a shell command into commands and words, without running a shell. It knows single and double quotes, the
 * backslash (and a backslash before a newline as a line continuation), and splits commands at `&&`, `||`, `;`, `|`
 * and a newline outside quotes. Here-document bodies are dropped. With `home`, a `~` that starts a word and a
 * `$HOME` or `${HOME}` outside single quotes become that directory; nothing else is expanded.
 * @param command - The text of a shell call.
 * @param home - The home directory to expand to; undefined expands nothing.
 * @returns The commands in order, each a list of unquoted words. A command with no word is left out.
 */
export function shellWords(command: string, home?: string): string[][] {
  const text = withoutHeredocs(command);
  const reading: Reading = {
    segments: [],
    words: [],
    word: "",
    started: false,
  };
  let at = 0;
  while (at < text.length) {
    const { add, width, ends } = piece(text, at, {
      home,
      started: reading.started,
    });
    if (ends === "command") endSegment(reading);
    if (ends === "word") endWord(reading);
    if (add !== null) {
      reading.word += add;
      reading.started = true;
    }
    at += width;
  }
  endSegment(reading);
  return reading.segments;
}
