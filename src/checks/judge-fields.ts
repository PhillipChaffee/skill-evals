import { UsageError, isObject } from "../scope.js";
import type { FieldDef, FieldParser, FieldType } from "./fields.js";

/** What a judge or decision model may be shown besides the task. */
const SEES_VALUES = ["final", "transcript", "files"] as const;
/** One thing a judge or decision model sees. */
export type Sees = (typeof SEES_VALUES)[number];
/** How a judge scores: a pass or a fail, or a number from 0 to 1. */
const SCALES = ["binary", "0-1"] as const;
/** The scale of a judge check. */
export type Scale = (typeof SCALES)[number];
/** What a good answer does: text, or one text for each verdict. */
export type Rubric = string | { pass: string; fail: string };

// The fields that tell a judge or decision model what to look at, in the order the docs list them.
const SEES_FIELDS: Record<string, FieldDef> = {
  sees: {
    type: "texts",
    values: SEES_VALUES,
    meaning:
      'What the model is shown: a non-empty list of "final" (the final answer), "transcript" (a compact rendering of what the agent did) and "files" (the files that `files` names). Default: `["final"]`, which is what 0.0.1 sent.',
  },
  files: {
    type: "texts",
    meaning:
      'A non-empty list of paths or globs, relative to the workspace, whose files the model sees when `sees` includes "files". Each file is cut to 20,000 characters, a binary file or an image is named and not shown, and a glob that matches nothing is stated in the prompt.',
  },
  maxChars: {
    type: "int",
    meaning:
      'The most characters of the transcript rendering. Tool outputs are cut to 400 characters first, then the oldest are dropped. Needs "transcript" in `sees`. Default: 60,000.',
  },
};

// The fields of a judge check, in the order the docs list them, and of what it sees, which a decision check takes too.
export const JUDGE_FIELDS: Record<string, FieldDef> = {
  rubric: {
    type: "rubric",
    meaning:
      "What a good answer does: plain text, or an object `{ pass, fail }` of two texts that say what passes and what fails.",
  },
  scale: {
    type: "enum",
    values: SCALES,
    meaning:
      'How the judge scores: "binary" (a pass is 1, a fail is 0) or "0-1" (a number from 0 to 1). Default: "0-1".',
  },
  votes: {
    type: "int",
    meaning:
      "An odd number of judge calls for one check. Binary scores the majority, 0-1 the median. Default: 1.",
  },
  ...SEES_FIELDS,
};

const PAIR = 2;

const failure = (where: string, problem: string): UsageError =>
  new UsageError(`${where}: ${problem}`);

/** The parsers of the field types this module owns. */
export const JUDGE_PARSERS: Pick<Record<FieldType, FieldParser>, "rubric"> = {
  rubric: (value, at) => {
    if (!isObject(value) && (typeof value !== "string" || value === "")) {
      throw failure(at.where, `${at.owner} needs a string "${at.name}"`);
    }
    const text = (item: unknown): boolean =>
      typeof item === "string" && item !== "";
    const keys = isObject(value) ? Object.keys(value).sort() : [];
    const pair =
      isObject(value) &&
      keys.join() === "fail,pass" &&
      text(value["pass"]) &&
      text(value["fail"]);
    if (!text(value) && !pair) {
      throw failure(
        at.where,
        `${at.name} must be text or an object with "pass" and "fail" text`,
      );
    }
    return value;
  },
};

/**
 * Checks the fields of a judge or decision check against each other.
 * @param given - The fields that are set, each already of its type.
 * @param where - Names the file and the check in an error message.
 * @throws {UsageError} When `votes` is even, `sees` has "files" and `files` is missing, `files` is given without it, or `maxChars` is given without "transcript".
 */
export function checkModelFields(
  given: Record<string, unknown>,
  where: string,
): void {
  const votes = given["votes"];
  if (typeof votes === "number" && votes % PAIR === 0) {
    throw failure(where, "votes must be an odd positive integer");
  }
  const sees = (given["sees"] as Sees[] | undefined) ?? [];
  const known = sees.every((one) => SEES_VALUES.includes(one));
  if (!known || new Set(sees).size !== sees.length) {
    throw failure(
      where,
      '"sees" must be a non-empty list of "final", "transcript" or "files", each at most once',
    );
  }
  if (sees.includes("files") && given["files"] === undefined) {
    throw failure(where, 'sees "files" needs "files", a list of globs');
  }
  if (!sees.includes("files") && given["files"] !== undefined) {
    throw failure(where, '"files" needs "sees" to include "files"');
  }
  if (!sees.includes("transcript") && given["maxChars"] !== undefined) {
    throw failure(where, '"maxChars" needs "sees" to include "transcript"');
  }
}
