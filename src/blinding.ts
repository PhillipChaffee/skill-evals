import { UsageError, isObject } from "./scope.js";

/**
 * Roots of words that tell an agent it is being evaluated: a prompt, a path or the environment that holds one may
 * change what the agent does. A root matches with an optional ending from `BLINDING_ENDINGS`, so "evaluat" finds
 * evaluate, evaluation and evaluator. Config `blindingWords` replaces this list and follows the same rule.
 */
export const DEFAULT_BLINDING_WORDS: readonly string[] = [
  "eval",
  "evaluat",
  "test",
  "judg",
  "experiment",
  "rubric",
  "scor",
  "compar",
  "benchmark",
  "candidat",
  "arena",
];

/** The endings that a root may take. */
export const BLINDING_ENDINGS: readonly string[] = [
  "e",
  "es",
  "ed",
  "ing",
  "er",
  "ers",
  "or",
  "ors",
  "ion",
  "ions",
  "ive",
  "ment",
  "ments",
  "al",
  "s",
  "ation",
  "ations",
];

// A word is a run of letters, so "_", "-", "." and digits end it, and "contest" does not hold "test".
const ENDINGS = BLINDING_ENDINGS.join("|");
const CAMEL = /([\p{Ll}\p{N}])(\p{Lu})/gu;
/** What a blinding word must look like: letters, digits and hyphens, starting with a letter. */
const WORD_SHAPE = /^\p{L}[\p{L}\p{N}-]*$/u;

const compiled = new Map<string, RegExp>();

/**
 * Builds the pattern of one word, once.
 * @param word - A blinding word, lowercase.
 * @returns The pattern: the word with an optional ending, between non-letters, on lowercase text.
 */
function patternOf(word: string): RegExp {
  let pattern = compiled.get(word);
  if (pattern === undefined) {
    pattern = new RegExp(`(?<!\\p{L})${word}(?:${ENDINGS})?(?!\\p{L})`, "u");
    compiled.set(word, pattern);
  }
  return pattern;
}

/**
 * Finds the listed words in a text, a path or a name.
 * @param text - What the agent may read. A camelCase name is split first, and case does not matter.
 * @param words - The blinding words, lowercase.
 * @returns Each listed word that occurs in the text, once, in the order of the list. "test_parse", "run_tests",
 *   "RunTest" and "test2" hold "test"; "contest", "latest" and "attestation" do not.
 */
export function textHits(text: string, words: readonly string[]): string[] {
  const lowered = text.replace(CAMEL, "$1 $2").toLowerCase();
  return words.filter((word) => patternOf(word).test(lowered));
}

/**
 * Checks a list of blinding words.
 * @param list - What the config file or a case lists.
 * @param where - Names the list in the message.
 * @throws {UsageError} For an entry that is not lowercase letters, digits and hyphens that starts with a letter: a word
 *   with punctuation or a space could never match.
 */
export function requireBlindingWords(list: string[], where: string): void {
  for (const word of list) {
    if (!WORD_SHAPE.test(word) || word !== word.toLowerCase()) {
      throw new UsageError(
        `${where} needs lowercase words of letters, digits and hyphens that start with a letter, not "${word}"`,
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
