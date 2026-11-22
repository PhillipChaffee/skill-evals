import { readNeeds } from "../capabilities.js";
import { caseEnvProblem } from "../env.js";
import { CALL_FIELDS, parseBy, parseVias } from "./call-fields.js";
import { COMMAND_FIELDS } from "./command-fields.js";
import { NEED_FIELDS } from "./need-fields.js";
import { FILE_FIELDS } from "./file-fields.js";
import { JUDGE_FIELDS, JUDGE_PARSERS } from "./judge-fields.js";
import { TRANSCRIPT_FIELDS } from "./transcript-fields.js";
import { pathProblem } from "./path-problem.js";
import { regex } from "./rules.js";
import { readSteps } from "../setup-steps.js";
import { TOOL_KINDS } from "../harnesses/shared.js";
import { isObject, messageOf } from "../scope.js";
import {
  failure,
  nonEmptyObjects,
  objects,
  ranged,
  text,
  whole,
} from "./field-read.js";
import type { FieldDefault } from "./field-default.js";

export { WEIGHT } from "./field-default.js";

/** What a field holds, which decides how loading a case parses it. */
export type FieldType =
  | "text"
  | "regex"
  | "flags"
  | "path"
  | "glob"
  | "kind"
  | "int"
  | "count"
  | "unit"
  | "signed"
  | "number"
  | "bool"
  | "enum"
  | "texts"
  | "tags"
  | "slug"
  | "variants"
  | "turns"
  | "answers"
  | "rubric"
  | "harnesses"
  | "envvars"
  | "needs"
  | "steps"
  | "matcher"
  | "matchers"
  | "vias"
  | "by"
  | "scope"
  | "object";

/** One field of a check, or one top-level key of a case file. */
export interface FieldDef {
  type: FieldType;
  /** What the field holds, in one sentence for the docs. */
  meaning: string;
  /** What the rules apply when the field is absent. Absent here: the field has no default, which `meaning` may explain. */
  default?: FieldDefault;
  /** The allowed words of an `enum`. */
  values?: readonly string[];
  /** What an error message says the value must be, where the type's own wording is too general. */
  expected?: string;
  /** For a `matcher` or `matchers`: the keys it takes besides the matcher keys, each with its own definition. */
  extras?: Record<string, FieldDef>;
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
  ...CALL_FIELDS,
  ...TRANSCRIPT_FIELDS,
  ...FILE_FIELDS,
  ...COMMAND_FIELDS,
  ...JUDGE_FIELDS,
  question: { type: "text", meaning: "A question about the final answer." },
  expect: {
    type: "enum",
    values: ["yes", "no"],
    meaning:
      'The answer that scores 1 for a yes or no question: "yes" or "no".',
  },
  options: {
    type: "answers",
    expected:
      "an object of at least two named answers, each with a number from 0 to 1",
    meaning:
      "An object of at least two answers, each with a number from 0 to 1 that says what the answer is worth.",
  },
  ...NEED_FIELDS,
};

/** The fields whose value is a regular expression, in the order of `FIELDS`. */
export const REGEX_FIELDS = Object.entries(FIELDS)
  .filter(([, def]) => def.type === "regex")
  .map(([name]) => name);

/** A tag or a variant id: lowercase letters, digits and hyphens, and it does not start with a hyphen. */
export const SLUG_PATTERN = "^[a-z0-9][a-z0-9-]*$";
const TAG = new RegExp(SLUG_PATTERN);
const SLUG_RULE =
  "lowercase letters, digits and hyphens, starting with a letter or digit";

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
    const problem = pathProblem(file);
    if (problem) throw failure(at, problem);
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
  int: whole(1, "a positive integer"),
  count: whole(0, "a whole number, 0 or more"),
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
      throw failure(at, `"${at.name}" must be a list of tags: ${SLUG_RULE}`);
    }
    return value as string[];
  },
  slug: (value, at) => {
    if (typeof value !== "string" || !TAG.test(value)) {
      throw failure(at, `"${at.name}" must be a slug: ${SLUG_RULE}`);
    }
    return value;
  },
  ...JUDGE_PARSERS,
  answers: (value, at) => PARSERS.object(value, at),
  harnesses: (value, at) => PARSERS.texts(value, at),
  variants: nonEmptyObjects,
  turns: nonEmptyObjects,
  envvars: (value, at) => {
    if (!isObject(value)) {
      throw failure(at, `"${at.name}" must be an object of variable values`);
    }
    const problem = Object.entries(value)
      .map(([name, setting]) => caseEnvProblem(name, setting))
      .find(Boolean);
    if (problem) throw failure(at, `${at.name} ${problem}`);
    return value;
  },
  needs: (value, at) => readNeeds(value, at.where),
  steps: (value, at) => readSteps(value, at.where),
  vias: parseVias,
  by: (value, at) => parseBy(value, at.where),
  scope: (value, at) => PARSERS.object(value, at),
  matcher: (value, at) => PARSERS.object(value, at),
  matchers: (value, at) => objects(value, at),
  object: (value, at) => {
    if (!isObject(value)) {
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
