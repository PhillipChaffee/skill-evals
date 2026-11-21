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
}
/** The name of a field a check may carry. */
export type Field = keyof CheckFields;

/** A check that a rule scores from what the run left behind. */
export type RuledCheck = CheckFields & { type: RuledType; weight: number };
/** A check that a model scores against a rubric. */
export type JudgedCheck = CheckFields & {
  type: "judge";
  weight: number;
  rubric: string;
};
/** One thing a case expects of a run. */
export type Check = RuledCheck | JudgedCheck;

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
  oneOf?: Field[];
  rule?: Rule;
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
  more: Omit<Spec, "fields" | "rule"> = {},
): Spec & { rule: Rule } => ({
  fields,
  ...more,
  rule: (check, outcome) => Number(test(check as With<F>, outcome)),
});
const fails = <F extends Field>(
  fields: F[],
  test: Test<F>,
  more?: Omit<Spec, "fields" | "rule">,
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
  skill_loaded: holds(["skill"], skillLoaded),
  skill_not_loaded: fails(["skill"], skillLoaded),
  output_matches: holds(["pattern"], outputMatches, FLAGS),
  output_lacks: fails(["pattern"], outputMatches, FLAGS),
  output_contains: holds(["text"], outputContains),
  output_not_contains: fails(["text"], outputContains),
  file_exists: holds(
    ["path"],
    (check, outcome) => fileText(check, outcome) !== null,
  ),
  file_matches: holds(
    ["path", "pattern"],
    (check, outcome) => {
      const text = fileText(check, outcome);
      return text !== null && regex(check.pattern, check.flags).test(text);
    },
    FLAGS,
  ),
  tool_called: holds([], toolCalled, TOOL_FIELDS),
  tool_not_called: fails([], toolCalled, TOOL_FIELDS),
};
type RuledType = keyof typeof RULED;

// Every check type. A type with no rule is scored by a model instead (see judge.ts).
export const CHECKS: Record<string, Spec> = {
  ...RULED,
  judge: { fields: ["rubric"] },
};

/**
 * Tells the two ways of scoring a check apart.
 * @param check - Any check of a case.
 * @returns True when a model scores the check, false when a rule does.
 */
export const isJudged = (check: Check): check is JudgedCheck =>
  check.type === "judge";

/**
 * Scores a deterministic check.
 * @param check - A check that is not judged.
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
 * @returns Its type and what it looks for; long text is cut short, and a weight other than 1 is shown.
 */
export function describeCheck(check: Check): string {
  const quoted = [check.text, check.rubric]
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
  return [
    check.type,
    check.skill,
    check.path,
    check.kind,
    ...quoted,
    ...patterns,
    ...weight,
  ]
    .filter(Boolean)
    .join(" ");
}
