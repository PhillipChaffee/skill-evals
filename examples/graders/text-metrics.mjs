#!/usr/bin/env node
// Text-metrics: checks a text file for long sentences and banned phrases. Use it as a `command` check on prose.
//
//   node text-metrics.mjs <file> [--max-sentence-words <n>] [--percentile <p>] [--banned <file>] [--strip-code]
//
// Exit codes: 0 prints `ok`; 1 prints one violation per line; 2 is a usage error, with the reason on standard error.
//
// Sentences: the text is split after each `.`, `!` or `?` that is followed by whitespace or the end of the text.
// Nothing else ends a sentence, and abbreviations are not special-cased: "e.g. this" is two sentences, and "Dr. Who"
// is two. A line break is whitespace, so a list item without a full stop runs into the next one.
// Words: a sentence's words are its runs of characters that are not whitespace.
//
// --max-sentence-words n  Every sentence must have at most n words.
// --percentile p          p is from 0 to 100. Only the p-th percentile of the sentence word counts (nearest rank:
//                         the count at rank ceil(p / 100 * sentences) of the sorted counts, and the smallest count for
//                         p of 0) must be at most the maximum, so a few long sentences may pass. Needs
//                         --max-sentence-words.
// --banned <file>         A file with one phrase on each line; blank lines are skipped. A phrase matches
//                         case-insensitively and on whole words, and any run of whitespace in it matches any run of
//                         whitespace in the text.
// --strip-code            Removes fenced code blocks (``` or ~~~) and inline code (`...`) before anything is counted,
//                         the banned phrases included.
import console from "node:console";
import fs from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";

const OK = 0;
const VIOLATION = 1;
const USAGE = 2;
const PERCENT = 100;
const SHOWN_WORDS = 8;

/**
 * Stops with a usage error.
 * @param {string} message - What is wrong with the command line.
 * @returns {never} Never: the process exits with code 2.
 */
function usage(message) {
  console.error(`text-metrics: ${message}`);
  process.exit(USAGE);
}

/**
 * Removes the code from a text.
 * @param {string} text - The text.
 * @returns {string} The text without fenced code blocks and inline code spans.
 */
function stripCode(text) {
  return text
    .replace(
      /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm,
      "",
    )
    .replace(/`[^`\n]*`/g, "");
}

/**
 * Splits a text into sentences.
 * @param {string} text - The text.
 * @returns {string[]} The sentences, trimmed: the text cut after each `.`, `!` or `?` that is followed by whitespace or
 *   the end of the text. Empty pieces are dropped.
 */
function sentencesOf(text) {
  return text
    .split(/(?<=[.!?])(?:\s+|$)/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

/**
 * Counts the words of a sentence.
 * @param {string} sentence - One sentence.
 * @returns {number} The number of runs of characters that are not whitespace.
 */
const wordsIn = (sentence) => sentence.split(/\s+/).filter(Boolean).length;

/**
 * Finds a percentile of a list of numbers, by nearest rank.
 * @param {number[]} counts - The numbers.
 * @param {number} percentile - From 0 to 100.
 * @returns {number} The number at rank ceil(percentile / 100 * length) of the sorted list, the smallest for 0.
 */
function percentileOf(counts, percentile) {
  const sorted = [...counts].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((percentile / PERCENT) * sorted.length));
  return sorted[rank - 1];
}

/**
 * Reads a number option.
 * @param {string | undefined} given - The option's text, or undefined when it is absent.
 * @param {string} name - The option's name, for the message.
 * @returns {number | undefined} The number; undefined when the option is absent.
 */
function numberOf(given, name) {
  if (given === undefined) return undefined;
  const value = Number(given);
  if (given.trim() === "" || !Number.isFinite(value)) {
    usage(`--${name} needs a number, not "${given}"`);
  }
  return value;
}

/**
 * Reads a file that the command line names.
 * @param {string} file - The path.
 * @param {string} what - What the file is, for the message.
 * @returns {string} The file's text.
 */
function readText(file, what) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    return usage(`cannot read ${what} ${file}: ${error.code ?? error.message}`);
  }
}

/**
 * Lists the sentences that are too long, or says the percentile is.
 * @param {string[]} sentences - The sentences of the text.
 * @param {{ max: number | undefined, percentile: number | undefined }} limits - The limits.
 * @returns {string[]} One violation for each sentence above the maximum, or one for the percentile.
 */
function lengthViolations(sentences, { max, percentile }) {
  if (max === undefined || sentences.length === 0) return [];
  const counts = sentences.map(wordsIn);
  if (percentile !== undefined) {
    const found = percentileOf(counts, percentile);
    return found > max
      ? [
          `percentile ${String(percentile)} of sentence length is ${String(found)} words, above the maximum of ${String(max)}`,
        ]
      : [];
  }
  return sentences.flatMap((sentence, index) =>
    counts[index] > max
      ? [
          `sentence ${String(index + 1)} has ${String(counts[index])} words, above the maximum of ${String(max)}: "${sentence.split(/\s+/).slice(0, SHOWN_WORDS).join(" ")} ..."`,
        ]
      : [],
  );
}

/**
 * Lists the banned phrases that the text holds.
 * @param {string} text - The text.
 * @param {string} file - The file of banned phrases, one on each line.
 * @returns {string[]} One violation for each phrase that appears, with how often.
 */
function bannedViolations(text, file) {
  const phrases = readText(file, "the banned phrases file")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return phrases.flatMap((phrase) => {
    const escaped = phrase
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
      "giu",
    );
    const found = text.match(pattern)?.length ?? 0;
    return found === 0
      ? []
      : [
          `banned phrase "${phrase}" appears ${String(found)} time${found === 1 ? "" : "s"}`,
        ];
  });
}

/**
 * Runs the command line.
 * @returns {number} The exit code.
 */
function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        "max-sentence-words": { type: "string" },
        percentile: { type: "string" },
        banned: { type: "string" },
        "strip-code": { type: "boolean" },
      },
    });
  } catch (error) {
    return usage(error.message);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1)
    usage("takes exactly one file: text-metrics.mjs <file> [flags]");
  const max = numberOf(values["max-sentence-words"], "max-sentence-words");
  const percentile = numberOf(values.percentile, "percentile");
  if (max !== undefined && max < 0)
    usage("--max-sentence-words may not be negative");
  if (percentile !== undefined && (percentile < 0 || percentile > PERCENT)) {
    usage("--percentile must be from 0 to 100");
  }
  if (percentile !== undefined && max === undefined) {
    usage("--percentile needs --max-sentence-words");
  }
  const raw = readText(positionals[0], "the text file");
  const text = values["strip-code"] ? stripCode(raw) : raw;
  const violations = [
    ...lengthViolations(sentencesOf(text), { max, percentile }),
    ...(values.banned === undefined
      ? []
      : bannedViolations(text, values.banned)),
  ];
  console.log(violations.length === 0 ? "ok" : violations.join("\n"));
  return violations.length === 0 ? OK : VIOLATION;
}

process.exitCode = main();
