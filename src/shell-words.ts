const OPERATORS = new Set([";", "|", "\n"]);
const PAIR = 2;
const ESCAPABLE_IN_QUOTES = new Set(['"', "\\", "$", "`"]);

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
 * Reads the text of a quoted word.
 * @param command - The whole command.
 * @param start - The position of the opening quote.
 * @returns The unquoted text, and the position after the closing quote (the end when it never closes).
 */
function quoted(command: string, start: number): { text: string; end: number } {
  const quote = command.charAt(start);
  let text = "";
  let at = start + 1;
  while (at < command.length && command.charAt(at) !== quote) {
    const char = command.charAt(at);
    const next = command.charAt(at + 1);
    if (quote === '"' && char === "\\" && ESCAPABLE_IN_QUOTES.has(next)) {
      text += next;
      at += PAIR;
    } else {
      text += char;
      at += 1;
    }
  }
  return { text, end: at + 1 };
}

/**
 * Splits a shell command into commands and words, without running a shell. It knows single and double quotes and the
 * backslash, and splits commands at `&&`, `||`, `;`, `|` and a newline outside quotes. It expands nothing.
 * @param command - The text of a shell call.
 * @returns The commands in order, each a list of unquoted words. A command with no word is left out.
 */
export function shellWords(command: string): string[][] {
  const reading: Reading = {
    segments: [],
    words: [],
    word: "",
    started: false,
  };
  let at = 0;
  while (at < command.length) {
    const char = command.charAt(at);
    if (char === "'" || char === '"') {
      const { text, end } = quoted(command, at);
      reading.word += text;
      reading.started = true;
      at = end;
    } else if (char === "\\" && at + 1 < command.length) {
      reading.word += command.charAt(at + 1);
      reading.started = true;
      at += PAIR;
    } else if (
      OPERATORS.has(char) ||
      (char === "&" && command.charAt(at + 1) === "&")
    ) {
      endSegment(reading);
      at += char === "&" ? PAIR : 1;
    } else if (/\s/.test(char)) {
      endWord(reading);
      at += 1;
    } else {
      reading.word += char;
      reading.started = true;
      at += 1;
    }
  }
  endSegment(reading);
  return reading.segments;
}
