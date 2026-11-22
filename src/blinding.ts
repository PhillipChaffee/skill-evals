import { UsageError, isObject } from "./scope.js";

/**
 * Words that tell an agent it is being evaluated. A prompt, a path or the environment that holds one may change what
 * the agent does. Config `blindingWords` replaces this list.
 */
export const DEFAULT_BLINDING_WORDS: readonly string[] = [
  "eval",
  "test",
  "judge",
  "experiment",
  "rubric",
  "score",
  "compare",
  "benchmark",
  "candidate",
  "arena",
];

// A word and its stem forms, as a whole word. A word inside another word ("contest" for "test") does not match.
const STEM_SUFFIXES = "s|ed|ing|er|ation";
const PATH_SEPARATORS = /[-_./]/;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

const compiled = new Map<string, RegExp>();

/**
 * Builds the pattern of one word, once.
 * @param word - A blinding word, lowercase.
 * @returns The pattern: the word with an optional stem ending, as a whole word, case-insensitive.
 */
function patternOf(word: string): RegExp {
  let pattern = compiled.get(word);
  if (pattern === undefined) {
    const escaped = word.replace(REGEX_SPECIAL, "\\$&");
    pattern = new RegExp(`\\b(${escaped})(${STEM_SUFFIXES})?\\b`, "i");
    compiled.set(word, pattern);
  }
  return pattern;
}

/**
 * Finds the listed words in a text.
 * @param text - What the agent may read.
 * @param words - The blinding words, lowercase.
 * @returns Each listed word that occurs in the text as a whole word or with a stem ending, once, in the order of the
 *   list. Case does not matter.
 */
export const textHits = (text: string, words: readonly string[]): string[] =>
  words.filter((word) => patternOf(word).test(text));

/**
 * Finds the listed words in a path or a name.
 * @param name - A path, a file name or a variable name.
 * @param words - The blinding words, lowercase.
 * @returns The words that any segment holds; the segments are the parts between `-`, `_`, `.` and `/`.
 */
export const pathHits = (name: string, words: readonly string[]): string[] =>
  textHits(name.split(PATH_SEPARATORS).join(" "), words);

/**
 * Checks a list of blinding words.
 * @param list - What the config file or a case lists.
 * @param where - Names the list in the message.
 * @throws {UsageError} For an entry that is empty or not lowercase.
 */
export function requireBlindingWords(list: string[], where: string): void {
  for (const word of list) {
    if (word === "" || word !== word.toLowerCase()) {
      throw new UsageError(
        `${where} needs non-empty lowercase words, not "${word}"`,
      );
    }
  }
}

/** The words that a case may show, and why. */
export interface Unblinded {
  words: string[];
  why: string;
}

/**
 * Reads the `x-unblinded` key of a case or a variant.
 * @param extensions - The keys that start with `x-`.
 * @param file - The case file, for the message.
 * @returns The words and the reason, or null when the key is absent.
 * @throws {UsageError} When the key is not `{ words, why }` with a non-empty `why` and a list of lowercase words. This
 *   is a load error even under `--lenient`.
 */
export function readUnblinded(
  extensions: Record<string, unknown>,
  file: string,
): Unblinded | null {
  const given = extensions["x-unblinded"];
  if (given === undefined) return null;
  const where = `${file}: "x-unblinded"`;
  if (!isObject(given)) {
    throw new UsageError(`${where} must be an object: { "words", "why" }`);
  }
  const { words, why } = given;
  if (typeof why !== "string" || why.trim() === "") {
    throw new UsageError(
      `${where} needs a non-empty "why": say why this case must show the agent a word that hints at a test`,
    );
  }
  if (!Array.isArray(words) || words.some((one) => typeof one !== "string")) {
    throw new UsageError(`${where} needs "words", a list of strings`);
  }
  requireBlindingWords(words as string[], `${where} "words"`);
  return { words: words as string[], why };
}

/**
 * Reads `x-unblinded` without failing, for a record that was written by an earlier command.
 * @param extensions - The keys that start with `x-`.
 * @returns The words and the reason, or null when the key is absent or invalid.
 */
export function unblindedOf(
  extensions: Record<string, unknown>,
): Unblinded | null {
  try {
    return readUnblinded(extensions, "case");
  } catch {
    return null;
  }
}
