import fs from "node:fs";
import path from "node:path";
import type { ToolCall, ToolKind } from "./harnesses/shared.js";

/** The fields a check may carry beside its type and weight; which ones it takes depends on the type. */
interface CheckFields {
  skill?: string;
  pattern?: string;
  text?: string;
  path?: string;
  kind?: ToolKind;
  name?: string;
  inputMatches?: string;
  flags?: string;
  rubric?: string;
  question?: string;
  expect?: "yes" | "no";
}
/** The name of a field a check may carry. */
export type Field = keyof CheckFields;

// What each field holds, in one sentence. `options` is here too: only a decision check takes it, and it is the one
// field that is not text. The docs list the fields from this table.
export const FIELD_MEANINGS: Record<Field | "options", string> = {
  skill: "The name of a skill.",
  pattern: "A regular expression.",
  text: "Text to look for. The match is exact and case-sensitive.",
  path: "A file path inside the workspace.",
  kind: "What the tool does, with the same word in every harness.",
  name: "A regular expression for the harness's own tool name.",
  inputMatches:
    "A regular expression for the tool call's input, written as JSON.",
  flags: "The flags of the check's regular expressions.",
  rubric: "Plain text that says what a good answer does.",
  question: "A question about the final answer.",
  expect: 'The answer that scores 1 for a yes or no question: "yes" or "no".',
  options:
    "An object of at least two answers, each with a number from 0 to 1 that says what the answer is worth.",
};

/** A check that a rule scores from what the run left behind. */
export type RuledCheck = CheckFields & { type: RuledType; weight: number };
/** A check that a model scores against a rubric. */
export type JudgedCheck = CheckFields & {
  type: "judge";
  weight: number;
  rubric: string;
};
/**
 * A check that a decision model scores: it returns a probability for each allowed answer, and the score is the
 * expected value. Loading a case makes sure that exactly one of `expect` and `options` is set.
 */
export type DecisionCheck = CheckFields & {
  type: "decision";
  weight: number;
  question: string;
  /** Each allowed answer with what it is worth, from 0 to 1. Absent for a yes or no question, which `expect` scores. */
  options?: Record<string, number>;
};
/** One thing a case expects of a run. */
export type Check = RuledCheck | JudgedCheck | DecisionCheck;

/** What a deterministic check can observe. */
export interface Outcome {
  finalText: string;
  toolCalls: ToolCall[];
  skillsLoaded: string[];
  workspace: string;
}

export const REGEX_FIELDS = ["pattern", "name", "inputMatches"] as const;

type Rule = (check: RuledCheck, outcome: Outcome) => number;
/** A check type: the fields it requires, the fields it may take, and the rule that scores it from 0 to 1. */
export interface Spec {
  fields: Field[];
  optional?: Field[];
  /** At least one of these must be set. */
  oneOf?: Field[];
  rule?: Rule;
  /** What the check scores, in one sentence for the docs. A rule's sentence says when the score is 1. */
  scores: string;
  /** One more sentence about the fields, for what the lists above cannot say. */
  note?: string;
}
type With<F extends Field> = RuledCheck & Required<Pick<CheckFields, F>>;
type Test<F extends Field> = (check: With<F>, outcome: Outcome) => boolean;

/**
 * Compiles a pattern of a check.
 * @param pattern - The source of a regular expression.
 * @param flags - Its flags; none when absent.
 * @returns The expression.
 * @throws {SyntaxError} When the pattern or the flags are not valid.
 */
export const regex = (pattern: string, flags = ""): RegExp =>
  new RegExp(pattern, flags);

/**
 * Reads the file a check names.
 * @param check - A check with a path, which loading the case kept inside the workspace.
 * @param outcome - Where the workspace is.
 * @returns The file's text, or null when it cannot be read.
 */
function fileText(check: With<"path">, outcome: Outcome): string | null {
  try {
    return fs.readFileSync(path.join(outcome.workspace, check.path), "utf8");
  } catch {
    return null;
  }
}

const toolCalled: Test<never> = (check, outcome) =>
  outcome.toolCalls.some(
    (call) =>
      (check.kind === undefined || call.kind === check.kind) &&
      (check.name === undefined ||
        regex(check.name, check.flags).test(call.name)) &&
      (check.inputMatches === undefined ||
        regex(check.inputMatches, check.flags).test(
          JSON.stringify(call.input ?? null),
        )),
  );

// Loading a case checks that every field in `fields` is a string, which is what lets a test read them as set.
const holds = <F extends Field>(
  fields: F[],
  test: Test<F>,
  more: Omit<Spec, "fields" | "rule">,
): Spec & { rule: Rule } => ({
  fields,
  ...more,
  rule: (check, outcome) => Number(test(check as With<F>, outcome)),
});
const fails = <F extends Field>(
  fields: F[],
  test: Test<F>,
  more: Omit<Spec, "fields" | "rule">,
): Spec & { rule: Rule } =>
  holds(fields, (check, outcome) => !test(check, outcome), more);

const TOOL_FIELDS = {
  optional: ["kind", "name", "inputMatches", "flags"],
  oneOf: ["kind", "name"],
} satisfies Partial<Spec>;
const FLAGS = { optional: ["flags"] } satisfies Partial<Spec>;
const skillLoaded: Test<"skill"> = (check, outcome) =>
  outcome.skillsLoaded.includes(check.skill);
const outputMatches: Test<"pattern"> = (check, outcome) =>
  regex(check.pattern, check.flags).test(outcome.finalText);
const outputContains: Test<"text"> = (check, outcome) =>
  outcome.finalText.includes(check.text);

const RULED = {
  skill_loaded: holds(["skill"], skillLoaded, {
    scores: "The agent loaded that skill.",
  }),
  skill_not_loaded: fails(["skill"], skillLoaded, {
    scores: "The agent did not load that skill.",
  }),
  output_matches: holds(["pattern"], outputMatches, {
    ...FLAGS,
    scores: "The final answer matches the regular expression.",
  }),
  output_lacks: fails(["pattern"], outputMatches, {
    ...FLAGS,
    scores: "The final answer does not match the regular expression.",
  }),
  output_contains: holds(["text"], outputContains, {
    scores: "The final answer contains that text.",
  }),
  output_not_contains: fails(["text"], outputContains, {
    scores: "The final answer does not contain that text.",
  }),
  file_exists: holds(
    ["path"],
    (check, outcome) => fileText(check, outcome) !== null,
    { scores: "That file exists in the workspace after the run." },
  ),
  file_matches: holds(
    ["path", "pattern"],
    (check, outcome) => {
      const text = fileText(check, outcome);
      return text !== null && regex(check.pattern, check.flags).test(text);
    },
    {
      ...FLAGS,
      scores: "That file exists and matches the regular expression.",
    },
  ),
  tool_called: holds([], toolCalled, {
    ...TOOL_FIELDS,
    scores: "The agent made a tool call that fits every given field.",
  }),
  tool_not_called: fails([], toolCalled, {
    ...TOOL_FIELDS,
    scores: "The agent made no tool call that fits every given field.",
  }),
};
type RuledType = keyof typeof RULED;

// Every check type. A type with no rule is scored by a model instead (see judge.ts and decision.ts).
export const CHECKS: Record<string, Spec> = {
  ...RULED,
  judge: {
    fields: ["rubric"],
    scores: "Not 0 or 1. A model scores the final answer against the rubric.",
  },
  decision: {
    fields: ["question"],
    optional: ["expect"],
    scores:
      "Not 0 or 1. A decision model gives each allowed answer a probability, and the score is the expected value.",
    note: "It takes exactly one of `expect` and `options`.",
  },
};

/**
 * Tells the two ways of scoring a check apart.
 * @param check - Any check of a case.
 * @returns True when a model scores the check, false when a rule does.
 */
export const isJudged = (check: Check): check is JudgedCheck =>
  check.type === "judge";

/**
 * Finds the checks that a decision model scores.
 * @param check - Any check of a case.
 * @returns True when the score is the expected value of a decision model's probabilities.
 */
export const isDecision = (check: Check): check is DecisionCheck =>
  check.type === "decision";

/**
 * Scores a deterministic check.
 * @param check - A check that a rule scores.
 * @param outcome - What the run left behind.
 * @returns 1 when the check holds, 0 when it does not.
 */
export const checkScore = (check: RuledCheck, outcome: Outcome): number =>
  RULED[check.type].rule(check, outcome);

const SHOWN_TEXT_LENGTH = 60;
const ELLIPSIS = "...";

/**
 * Names a check in one line of a report.
 * @param check - Any check of a case.
 * @returns Its type and what it looks for; long text is cut short, a decision check names the answer it expects or
 *   its options, and a weight other than 1 is shown.
 */
export function describeCheck(check: Check): string {
  const quoted = [check.text, check.rubric, check.question]
    .filter((text) => text !== undefined)
    .map((text) =>
      JSON.stringify(
        text.length > SHOWN_TEXT_LENGTH
          ? `${text.slice(0, SHOWN_TEXT_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`
          : text,
      ),
    );
  const patterns = REGEX_FIELDS.flatMap((field) =>
    check[field] === undefined ? [] : [`/${check[field]}/${check.flags ?? ""}`],
  );
  const weight = check.weight === 1 ? [] : [`(weight ${String(check.weight)})`];
  const answers = isDecision(check)
    ? [check.expect ?? Object.keys(check.options ?? {}).join("/")]
    : [];
  return [
    check.type,
    check.skill,
    check.path,
    check.kind,
    ...quoted,
    ...answers,
    ...patterns,
    ...weight,
  ]
    .filter(Boolean)
    .join(" ");
}
