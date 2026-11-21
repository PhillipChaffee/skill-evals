import type { Capability, Need } from "../capabilities.js";
import type { ToolCall, ToolKind } from "../harnesses/shared.js";
import type { EndMatcher, ToolMatcher } from "../matchers.js";
import { isUnitScore } from "../score.js";
import type { ChangedFiles, Snapshot } from "../snapshot.js";
import { UsageError } from "../scope.js";
import { FILE_CHECKS } from "./files.js";
import type { Mode } from "./fields.js";
import { FIELDS, REGEX_FIELDS, WEIGHT, readField } from "./fields.js";
import { describeCalls, describeFiles } from "./describe.js";
import { extensionsOf } from "./extensions.js";
import { OBSERVED_CHECKS } from "./observed.js";
import { OUTPUT_CHECKS } from "./output.js";
import { ORDER_CHECKS } from "./order.js";
import { SKILL_CHECKS } from "./skills.js";
import { TOOL_CHECKS } from "./tools.js";

/** The fields a check may carry beside its type and weight; which ones it takes depends on the type. */
interface CheckFields {
  skill?: string;
  anyOf?: string[];
  min?: number;
  max?: number;
  sameTurn?: boolean;
  first?: boolean;
  before?: EndMatcher;
  after?: EndMatcher;
  sequence?: ToolMatcher[];
  strict?: boolean;
  matches?: ToolMatcher;
  ignoring?: ToolMatcher[];
  pattern?: string;
  text?: string;
  path?: string;
  kind?: ToolKind;
  name?: string;
  inputMatches?: string;
  flags?: string;
  inputLinesMax?: number;
  quantifier?: "any" | "all";
  root?: "workspace" | "home";
  created?: boolean;
  allow?: string[];
  ignore?: string[];
  rubric?: string;
  question?: string;
  expect?: "yes" | "no";
  /** What the harness must be able to do for the check to apply, besides what its type implies. */
  requires?: Need[];
  /** What a harness that lacks a need does: drop this check, or exclude the whole case. Default: the whole case. */
  ifUnsupported?: "skip" | "not-applicable";
  /** Keys that start with `x-` belong to the case author. Loading keeps them, and nothing reads them. */
  [extension: `x-${string}`]: unknown;
}
/** The name of a field a check may carry. */
export type Field = Exclude<
  keyof CheckFields,
  `x-${string}` | "requires" | "ifUnsupported"
>;

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
  /** The workspace as it was before the harness started: the hash of each file. */
  seed: Snapshot;
  /** What the run created, modified and deleted in the workspace, compared with `seed`. */
  changed: ChangedFiles;
  /** The run's throwaway home, for a check with `root: "home"`. */
  home: string;
  /** The home just before the harness's prompt ran: auth files and placed skills are in it, so they never read as the agent's. */
  homeSeed: Snapshot;
  /** What the run created, modified and deleted in the home, compared with `homeSeed`. */
  homeChanged: ChangedFiles;
  /** The per-run copy of the subject the harness loaded, and the paths of it that the run changed. `observed` is false
   * when the copy the agent saw could not be watched, which no check may read as "unchanged". */
  subject: { dir: string | null; mutated: string[]; observed?: boolean };
}

/** What a rule says of one run: a score from 0 to 1, and optionally why. */
export interface Verdict {
  score: number;
  reason?: string;
}
/** Scores one check from what the run left behind. */
export type Rule = (check: RuledCheck, outcome: Outcome) => Verdict;

/** A check type: the fields it requires, the fields it may take, and the rule that scores it from 0 to 1. */
export interface Spec {
  fields: string[];
  optional?: string[];
  /** At least one of these must be set. */
  oneOf?: string[];
  /** What the check scores, in one sentence for the docs. A rule's sentence says when the score is 1. */
  scores: string;
  /** One more sentence about the fields, for what the lists above cannot say. */
  note?: string;
  rule?: Rule;
  /** Fields that may only be given with others: field to the fields it needs. The JSON Schema says so. */
  together?: Record<string, string[]>;
  /** Keys of the matcher shape that no check can use yet: naming one is a load error in every mode, never dropped. */
  notYet?: string[];
  /**
   * Sets of fields of which exactly one set is given, for a check with more than one form. The JSON Schema says so;
   * `validate` gives the loader's message.
   */
  forms?: string[][];
  /** What a harness must be able to do for the check to apply, besides the check's own `requires`. */
  needs?: (check: Check) => Capability[];
  /** Looks at the fields together, once each is read, for a rule that depends on more than one. Throws a `UsageError`. */
  validate?: (given: Record<string, unknown>, where: string) => void;
}
/** A ruled check whose fields in `F` are set, which loading the case made sure of. */
export type With<F extends Field> = RuledCheck & Required<Pick<CheckFields, F>>;
/** The test of a rule over the fields it needs. */
export type Test<F extends Field> = (
  check: With<F>,
  outcome: Outcome,
) => boolean;

const RULED = {
  ...SKILL_CHECKS,
  ...OUTPUT_CHECKS,
  ...FILE_CHECKS,
  ...TOOL_CHECKS,
  ...ORDER_CHECKS,
  ...OBSERVED_CHECKS,
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
    optional: ["expect", "options"],
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
 * @returns The verdict: 1 when the check holds, 0 when it does not.
 */
export const checkScore = (check: RuledCheck, outcome: Outcome): Verdict =>
  RULED[check.type].rule(check, outcome);

// A question with one allowed answer decides nothing.
const MIN_OPTIONS = 2;

/**
 * Reads the answers a decision check allows.
 * @param given - The fields of the check that are set; `expect` and `options` are already of their types.
 * @param where - Names the file and the check in an error message.
 * @returns The `options` of the check; nothing for a yes or no question, which `expect` scores.
 * @throws {UsageError} Unless exactly one of `expect` and `options` is set, and `options` holds at least two named
 *   answers, each worth a number from 0 to 1.
 */
function readAnswers(
  given: Record<string, unknown>,
  where: string,
): { options?: Record<string, number> } {
  const { expect, options } = given;
  if ((expect === undefined) === (options === undefined)) {
    throw new UsageError(
      `${where}: decision needs exactly one of "expect" and "options"`,
    );
  }
  if (expect !== undefined) return {};
  const entries = Object.entries(options as Record<string, unknown>);
  if (
    entries.length < MIN_OPTIONS ||
    !entries.every(([label, value]) => label !== "" && isUnitScore(value))
  ) {
    throw new UsageError(
      `${where}: "options" must be ${FIELDS["options"]?.expected ?? "an object"}`,
    );
  }
  return { options: Object.fromEntries(entries) as Record<string, number> };
}

/**
 * Validates one check of a case file.
 * @param raw - The parsed check.
 * @param where - Names the file and the check in an error message.
 * @param mode - Whether a key the check does not take is an error or is dropped with a warning.
 * @returns The check, holding the fields its type takes and the keys that start with `x-`.
 * @throws {UsageError} For an unknown type, an unknown key, a bad weight, or a field that is missing or unusable.
 */
export function readCheck(raw: unknown, where: string, mode: Mode): Check {
  const record =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const type = record?.["type"];
  const spec =
    typeof type === "string" && Object.hasOwn(CHECKS, type)
      ? CHECKS[type]
      : undefined;
  if (!record || !spec || typeof type !== "string") {
    throw new UsageError(
      `${where}: unknown check type ${JSON.stringify(type)}; known: ${Object.keys(CHECKS).join(", ")}`,
    );
  }
  const unsupported = (spec.notYet ?? []).find((key) => key in record);
  if (unsupported) {
    throw new UsageError(`${where}: "${unsupported}" is not yet supported`);
  }
  const optional = (spec.optional ?? []).filter(
    (field) => record[field] !== undefined,
  );
  const at = { where, owner: type, siblings: record };
  const extensions = extensionsOf(
    [
      ...["type", "weight", "requires", "ifUnsupported"],
      ...spec.fields,
      ...(spec.optional ?? []),
    ],
    at,
    mode,
  );
  const weight =
    record["weight"] === undefined || record["weight"] === null
      ? 1
      : readField({ weight: WEIGHT }, "weight", at);
  const given: Record<string, unknown> = {};
  const capabilities = ["requires", "ifUnsupported"].filter(
    (field) => record[field] !== undefined,
  );
  for (const field of [...spec.fields, ...optional, ...capabilities]) {
    given[field] = readField(FIELDS, field, at);
  }
  if (spec.oneOf && !spec.oneOf.some((field) => given[field] !== undefined)) {
    throw new UsageError(
      `${where}: ${type} needs at least one of ${spec.oneOf.map((field) => `"${field}"`).join(", ")}`,
    );
  }
  spec.validate?.(given, where);
  const answers = type === "decision" ? readAnswers(given, where) : {};
  // The steps above checked the type, the fields it requires, and the answers of a decision.
  return { type, weight, ...given, ...answers, ...extensions } as Check;
}

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
  const patterns = REGEX_FIELDS.flatMap((field) => {
    const pattern = check[field as Field] as string | undefined;
    return pattern === undefined ? [] : [`/${pattern}/${check.flags ?? ""}`];
  });
  const weight = check.weight === 1 ? [] : [`(weight ${String(check.weight)})`];
  const answers = isDecision(check)
    ? [check.expect ?? Object.keys(check.options ?? {}).join("/")]
    : [];
  return [
    check.type,
    check.skill,
    check.path,
    ...describeFiles(check),
    check.kind,
    ...quoted,
    ...answers,
    ...patterns,
    ...describeCalls(check),
    ...weight,
  ]
    .filter(Boolean)
    .join(" ");
}
