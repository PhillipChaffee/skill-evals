import type { Capability } from "../capabilities.js";
import { tester } from "../matchers.js";
import { resultsByCall } from "../transcript.js";
import type { Check, Outcome, RuledCheck, Spec, Verdict } from "./index.js";
import { UsageError } from "../scope.js";
import { PASS } from "./rules.js";
import { SUBAGENT_CAVEAT } from "./transcript-fields.js";
import type { Piece } from "./transcript-slice.js";
import { pieces, quotePieces } from "./transcript-slice.js";
import { outputLacks, outputMatches, outputSize } from "./transcript-output.js";
import "./transcript-scope.js";

const FIELDS_OF_TEXT = { optional: ["flags", "where", "scope"] };
const CAP_NOTE =
  SUBAGENT_CAVEAT +
  " A pattern sees at most the first 1,000,000 characters of each event. `first_message` is the main agent's first non-empty text, which in a kit whose first action is a tool call is not the text before the first tool call. `by` is not yet supported.";

/**
 * Lists what a check of text needs.
 * @param check - A `transcript_matches` or `transcript_lacks` check.
 * @returns `assistantText` for the default `where`, `toolOutputs` for `tool_output` and `all`, and nothing for
 *   `tool_input`, which every adapter supplies.
 */
function textNeeds(check: Check): Capability[] {
  const where = check.where ?? "assistant_text";
  if (where === "assistant_text") return ["assistantText"];
  return where === "tool_input" ? [] : ["toolOutputs"];
}

/**
 * Checks that a message scope reads assistant text.
 * @param given - The fields that are set.
 * @param where - Names the file and the check in an error message.
 * @throws {UsageError} When `scope` is `first_message`, `final_message` or the bounded form, and `where` is not `assistant_text`.
 */
function checkMessageWhere(
  given: Record<string, unknown>,
  where: string,
): void {
  const { scope } = given;
  const message =
    scope === "first_message" ||
    scope === "final_message" ||
    (typeof scope === "object" && scope !== null && "first_message" in scope);
  if (
    message &&
    given["where"] !== undefined &&
    given["where"] !== "assistant_text"
  ) {
    throw new UsageError(
      `${where}: first_message and final_message read assistant text; drop "where" or set it to "assistant_text"`,
    );
  }
}

const written = (check: RuledCheck): string =>
  `/${check.pattern ?? ""}/${check.flags ?? ""}`;

/**
 * Tests the texts of a check against its pattern.
 * @param check - A `transcript_matches` or `transcript_lacks` check.
 * @param outcome - What the run left behind.
 * @returns The texts the scope and `where` give and which of them match, or why the scope gave none to test.
 */
function tested(
  check: RuledCheck,
  outcome: Outcome,
): { all: Piece[]; hits: Piece[] } | { problem: string } {
  const cut = pieces(
    outcome.transcript,
    check.scope ?? "any",
    check.where ?? "assistant_text",
  );
  if ("problem" in cut) return cut;
  const fits = tester(check.pattern, check.flags);
  return { all: cut.pieces, hits: cut.pieces.filter(({ text }) => fits(text)) };
}

/**
 * Scores `transcript_matches`.
 * @param check - The check, whose `pattern`, `flags` and the fields of its type are read.
 * @param outcome - What the run left behind.
 * @returns 1 when some tested text matches.
 */
function textMatches(check: RuledCheck, outcome: Outcome): Verdict {
  const found = tested(check, outcome);
  if ("problem" in found) return { score: 0, reason: found.problem };
  if (found.hits.length > 0) return PASS;
  return {
    score: 0,
    reason: `no ${check.where ?? "assistant_text"} text matches ${written(check)} in ${String(found.all.length)} tested ${found.all.length === 1 ? "event" : "events"}\n${quotePieces(found.all)}`,
  };
}

/**
 * Finds a call inside the window of a check whose result event is missing.
 * @param check - A `transcript_lacks` check.
 * @param outcome - What the run left behind.
 * @returns The position, among the calls, of the first call of the window with no result; -1 for none.
 */
function silentCall(check: RuledCheck, outcome: Outcome): number {
  const cut = pieces(outcome.transcript, check.scope ?? "any", "all");
  if ("problem" in cut) return -1;
  const results = resultsByCall(outcome.transcript);
  let position = -1;
  for (const one of outcome.transcript) {
    if (one.type !== "tool_call") continue;
    position += 1;
    if (cut.window.includes(one) && !results.has(position)) return position;
  }
  return -1;
}

/**
 * Scores `transcript_lacks`.
 * @param check - The check, whose `pattern`, `flags` and the fields of its type are read.
 * @param outcome - What the run left behind.
 * @returns 1 when no tested text matches. A run with no events of the chosen `where` at all scores 0, which usually
 *   means the capture is broken; an empty window after a found cut passes.
 */
function textLacks(check: RuledCheck, outcome: Outcome): Verdict {
  const found = tested(check, outcome);
  if ("problem" in found) return { score: 0, reason: found.problem };
  const where = check.where ?? "assistant_text";
  const anywhere = pieces(outcome.transcript, "any", where);
  if (
    found.all.length === 0 &&
    "pieces" in anywhere &&
    anywhere.pieces.length === 0
  ) {
    return { score: 0, reason: `the run has no ${where} text to test` };
  }
  const silent =
    where === "tool_output" || where === "all"
      ? silentCall(check, outcome)
      : -1;
  if (found.hits.length === 0 && silent >= 0) {
    return {
      score: 0,
      reason: `call #${String(silent)} has no output, so it cannot be shown to lack the pattern`,
    };
  }
  if (found.hits.length === 0) return PASS;
  return {
    score: 0,
    reason: `${check.where ?? "assistant_text"} text matches ${written(check)} in ${String(found.hits.length)} of ${String(found.all.length)} tested events\n${quotePieces(found.hits)}`,
  };
}

const OUTPUT_FIELDS = {
  fields: ["tool", "pattern"],
  optional: ["flags", "which"],
  needs: (): Capability[] => ["toolOutputs"],
} satisfies Partial<Spec>;

// The checks of what the agent said and what its tools returned.
export const TRANSCRIPT_CHECKS = {
  transcript_matches: {
    fields: ["pattern"],
    ...FIELDS_OF_TEXT,
    notYet: ["by"],
    validate: checkMessageWhere,
    needs: textNeeds,
    scores:
      "At least one of the tested texts matches the regular expression: the assistant's text by default, or the tool inputs, tool outputs or all of them with `where`, in the events that `scope` names.",
    note: CAP_NOTE,
    rule: textMatches,
  },
  transcript_lacks: {
    fields: ["pattern"],
    ...FIELDS_OF_TEXT,
    notYet: ["by"],
    validate: checkMessageWhere,
    needs: textNeeds,
    scores:
      "None of the tested texts matches the regular expression. A run with no events of the chosen `where` at all (no assistant text, no tool results or no calls, as `where` says) scores 0, since that usually means the capture is broken. With `tool_output` or `all`, a call in the window with no result also scores 0, as for `tool_output_lacks`. An empty window after a found `before` or `after` cut passes, and a cut whose matcher matches no call scores 0.",
    note: CAP_NOTE,
    rule: textLacks,
  },
  tool_output_matches: {
    ...OUTPUT_FIELDS,
    scores:
      "The output of a call that fits `tool` matches the regular expression: any such call, or with `which` the first or the last. A call with no result does not match, and no such call scores 0.",
    note: "The output is the tool's own result, as the stream carried it, never the agent's account of it. A pattern sees at most the first 1,000,000 characters of an output. `flags` belong to `pattern`; the matcher has its own.",
    rule: outputMatches,
  },
  tool_output_lacks: {
    ...OUTPUT_FIELDS,
    scores:
      "No chosen call's output matches the regular expression. A chosen call with no result cannot be shown to lack the pattern, and no call that fits `tool` scores 0.",
    note: "Same fields as `tool_output_matches`.",
    rule: outputLacks,
  },
  tool_output_size: {
    fields: ["maxBytes"],
    optional: ["tool"],
    needs: (): Capability[] => ["toolOutputs"],
    scores:
      "No tool output, or none of the calls that fit `tool`, is over `maxBytes` bytes. A call with no result is ignored.",
    rule: outputSize,
  },
} satisfies Record<string, Spec>;
