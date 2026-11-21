import path from "node:path";
import { readNeeds } from "../capabilities.js";
import { caseEnvProblem } from "../env.js";
import { regex } from "./rules.js";
import { TOOL_KINDS } from "../harnesses/shared.js";
import { UsageError, messageOf } from "../scope.js";

/** What a field holds, which decides how loading a case parses it. */
export type FieldType =
  | "text"
  | "regex"
  | "flags"
  | "path"
  | "glob"
  | "kind"
  | "int"
  | "unit"
  | "signed"
  | "number"
  | "bool"
  | "enum"
  | "texts"
  | "tags"
  | "envvars"
  | "needs"
  | "matcher"
  | "matchers"
  | "object";

/** One field of a check, or one top-level key of a case file. */
export interface FieldDef {
  type: FieldType;
  /** What the field holds, in one sentence for the docs. */
  meaning: string;
  /** The allowed words of an `enum`. */
  values?: readonly string[];
  /** What an error message says the value must be, where the type's own wording is too general. */
  expected?: string;
}

/** What a parser knows about the value it reads. */
export interface FieldAt {
  /** Names the file, and the check in it, in an error message. */
  where: string;
  /** Names what the key belongs to in an error message: a check type, or "a case". */
  owner: string;
  /** Every key of the same object, so that a parser can read the keys it depends on, such as `flags`. */
  siblings: Record<string, unknown>;
}

/** Reads one value of a field type. */
export type FieldParser = (
  value: unknown,
  at: FieldAt & { name: string; def: FieldDef },
) => unknown;

/** How strict loading is about the keys it does not know. */
export interface Mode {
  /** Drop an unknown key and warn instead of failing. */
  lenient: boolean;
  /** Called with a line of text for each key that lenient loading drops. */
  warn?: (text: string) => void;
}

// What each field holds, in one sentence. `options` is here too: only a decision check takes it. The docs list the
// fields from this table, in this order.
export const FIELDS: Record<string, FieldDef> = {
  skill: { type: "text", meaning: "The name of a skill." },
  pattern: { type: "regex", meaning: "A regular expression." },
  text: {
    type: "text",
    meaning: "Text to look for. The match is exact and case-sensitive.",
  },
  path: { type: "path", meaning: "A file path inside the workspace." },
  kind: {
    type: "kind",
    meaning: "What the tool does, with the same word in every harness.",
  },
  name: {
    type: "regex",
    meaning: "A regular expression for the harness's own tool name.",
  },
  inputMatches: {
    type: "regex",
    meaning: "A regular expression for the tool call's input, written as JSON.",
  },
  flags: {
    type: "flags",
    meaning: "The flags of the check's regular expressions.",
  },
  rubric: {
    type: "text",
    meaning: "Plain text that says what a good answer does.",
  },
  question: { type: "text", meaning: "A question about the final answer." },
  expect: {
    type: "enum",
    values: ["yes", "no"],
    meaning:
      'The answer that scores 1 for a yes or no question: "yes" or "no".',
  },
  options: {
    type: "object",
    expected:
      "an object of at least two named answers, each with a number from 0 to 1",
    meaning:
      "An object of at least two answers, each with a number from 0 to 1 that says what the answer is worth.",
  },
  requires: {
    type: "needs",
    meaning:
      'A list of capabilities the check needs, such as `"mcp"`, or `"bin:<name>"` for an executable on the host\'s `PATH`. A harness that lacks one cannot run the check.',
  },
  ifUnsupported: {
    type: "enum",
    values: ["skip", "not-applicable"],
    meaning:
      'What a harness that lacks what the check needs does: "skip" drops this check and re-normalizes the weights, "not-applicable" excludes the whole case. Default: "not-applicable".',
  },
};

/** The `weight` of a check or of a case, which every one of them may carry. */
export const WEIGHT: FieldDef = {
  type: "number",
  meaning: "A positive number that says how much it counts. Default: 1.",
};

/** The fields whose value is a regular expression, in the order of `FIELDS`. */
export const REGEX_FIELDS = Object.entries(FIELDS)
  .filter(([, def]) => def.type === "regex")
  .map(([name]) => name);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Reads a value that must be a non-empty string.
 * @param value - The parsed value.
 * @param at - Where it is, and what it is.
 * @param at.name - The key.
 * @returns The string.
 * @throws {UsageError} When the value is not a non-empty string.
 */
function text(value: unknown, at: FieldAt & { name: string }): string {
  if (typeof value !== "string" || value === "") {
    throw new UsageError(
      `${at.where}: ${at.owner} needs a string "${at.name}"`,
    );
  }
  return value;
}

// A tag: lowercase letters, digits and hyphens, and it does not start with a hyphen.
const TAG = /^[a-z0-9][a-z0-9-]*$/;

const failure = (at: FieldAt, problem: string): UsageError =>
  new UsageError(`${at.where}: ${problem}`);

// A parser for a number from `low` to 1.
const ranged =
  (low: number): FieldParser =>
  (value, at) => {
    if (!(typeof value === "number" && value >= low && value <= 1)) {
      throw failure(at, `${at.name} must be a number from ${String(low)} to 1`);
    }
    return value;
  };

// The parser of each field type. A type whose real parser lives in another module starts with a plain one, and that
// module replaces it with registerParser. This module imports no module that uses it, so no cycle can form.
const PARSERS: Record<FieldType, FieldParser> = {
  text: (value, at) => text(value, at),
  regex: (value, at) => {
    const pattern = text(value, at);
    const { flags } = at.siblings;
    try {
      regex(pattern, typeof flags === "string" ? flags : "");
    } catch (error) {
      throw failure(at, messageOf(error));
    }
    return pattern;
  },
  flags: (value, at) => {
    const flags = text(value, at);
    try {
      regex("", flags);
    } catch (error) {
      throw failure(at, messageOf(error));
    }
    return flags;
  },
  path: (value, at) => {
    const file = text(value, at);
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
      throw failure(at, `path must stay inside the workspace: ${file}`);
    }
    return file;
  },
  glob: (value, at) => text(value, at),
  kind: (value, at) => {
    const kind = text(value, at);
    if (!(TOOL_KINDS as readonly string[]).includes(kind)) {
      throw failure(
        at,
        `unknown tool kind "${kind}"; known: ${TOOL_KINDS.join(", ")}`,
      );
    }
    return kind;
  },
  int: (value, at) => {
    if (!(typeof value === "number" && Number.isInteger(value) && value > 0)) {
      throw failure(at, `${at.name} must be a positive integer`);
    }
    return value;
  },
  unit: ranged(0),
  signed: ranged(-1),
  number: (value, at) => {
    if (!(typeof value === "number" && Number.isFinite(value) && value > 0)) {
      throw failure(at, `${at.name} must be a positive number`);
    }
    return value;
  },
  bool: (value, at) => {
    if (typeof value !== "boolean") {
      throw failure(at, `${at.name} must be true or false`);
    }
    return value;
  },
  enum: (value, at) => {
    const word = text(value, at);
    const values = at.def.values ?? [];
    if (!values.includes(word)) {
      throw failure(
        at,
        `"${at.name}" must be ${values.map((each) => `"${each}"`).join(" or ")}`,
      );
    }
    return word;
  },
  texts: (value, at) => {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((item) => typeof item === "string" && item !== "")
    ) {
      throw failure(
        at,
        `"${at.name}" must be a non-empty list of non-empty strings`,
      );
    }
    return value as string[];
  },
  tags: (value, at) => {
    if (
      !Array.isArray(value) ||
      !value.every((tag) => typeof tag === "string" && TAG.test(tag))
    ) {
      throw failure(
        at,
        `"${at.name}" must be a list of tags, each made of lowercase letters, digits and hyphens, starting with a letter or digit`,
      );
    }
    return value as string[];
  },
  envvars: (value, at) => {
    if (!isPlainObject(value)) {
      throw failure(at, `"${at.name}" must be an object of variable values`);
    }
    const problem = Object.entries(value)
      .map(([name, setting]) => caseEnvProblem(name, setting))
      .find(Boolean);
    if (problem) throw failure(at, `${at.name} ${problem}`);
    return value;
  },
  needs: (value, at) => readNeeds(value, at.where),
  matcher: (value, at) => {
    if (!isPlainObject(value)) {
      throw failure(at, `"${at.name}" must be an object`);
    }
    return value;
  },
  matchers: (value, at) => {
    if (!Array.isArray(value) || !value.every(isPlainObject)) {
      throw failure(at, `"${at.name}" must be a list of objects`);
    }
    return value;
  },
  object: (value, at) => {
    if (!isPlainObject(value)) {
      throw failure(
        at,
        `"${at.name}" must be ${at.def.expected ?? "an object"}`,
      );
    }
    return value;
  },
};

/**
 * Replaces the parser of a field type. The module that owns the real parser of a type calls this when it loads, so
 * `fields.ts` never imports it.
 * @param type - The field type.
 * @param parser - What reads a value of the type; it throws a `UsageError` for a value it rejects.
 * @returns The parser it replaced, so that a test can put it back.
 */
export function registerParser(
  type: FieldType,
  parser: FieldParser,
): FieldParser {
  const previous = PARSERS[type];
  PARSERS[type] = parser;
  return previous;
}

/**
 * Reads the value of one field with the parser of its type.
 * @param defs - The table that defines the field.
 * @param name - The key.
 * @param at - Where the key is; its `siblings` hold the value.
 * @returns The value, as its type's parser reads it.
 * @throws {UsageError} When the key is not in the table, or the parser rejects the value.
 */
export function readField(
  defs: Record<string, FieldDef>,
  name: string,
  at: FieldAt,
): unknown {
  const def = Object.hasOwn(defs, name) ? defs[name] : undefined;
  if (!def) throw failure(at, `unknown key "${name}"`);
  return PARSERS[def.type](at.siblings[name], { ...at, name, def });
}

/**
 * Finds the keys of an object that a case author may not use.
 * @param allowed - The keys the object may have.
 * @param at - Where the object is; its `siblings` are the object.
 * @param mode - Whether to fail or to drop the key and warn.
 * @returns The keys that start with `x-` and their values, which belong to the author. In lenient mode an unknown key
 *   is dropped from the result, and `mode.warn` hears of it.
 * @throws {UsageError} In strict mode, for a key that is not allowed and does not start with `x-`.
 */
export function extensionsOf(
  allowed: string[],
  at: FieldAt,
  mode: Mode,
): Record<string, unknown> {
  const extensions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(at.siblings)) {
    if (allowed.includes(key)) continue;
    if (key.startsWith("x-")) {
      extensions[key] = value;
    } else if (mode.lenient) {
      mode.warn?.(`${at.where}: ignored unknown key "${key}"`);
    } else {
      throw failure(
        at,
        `unknown key "${key}" for ${at.owner}; allowed: ${allowed.join(", ")}`,
      );
    }
  }
  return extensions;
}
