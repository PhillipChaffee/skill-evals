import type { Capability } from "../capabilities.js";
import type { ToolCall, TranscriptEvent } from "../harnesses/shared.js";
import type { ToolMatcher } from "../matchers.js";
import { describeMatcher, hitsOf, quoteCalls, tester } from "../matchers.js";
import { callsOf, resultsByCall } from "../transcript.js";
import type { Check, Outcome, RuledCheck, Spec, Verdict } from "./index.js";
import { UsageError } from "../scope.js";
import { PASS } from "./rules.js";
import type { Piece } from "./transcript-slice.js";
import { pieces, quoteEvent, quotePieces } from "./transcript-slice.js";
import { SUBAGENT_CAVEAT } from "./transcript-fields.js";
import "./transcript-scope.js";

const SHOWN_LINES = 5;
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
  if (found.hits.length === 0) return PASS;
  return {
    score: 0,
    reason: `${check.where ?? "assistant_text"} text matches ${written(check)} in ${String(found.hits.length)} of ${String(found.all.length)} tested events\n${quotePieces(found.hits)}`,
  };
}

/** A call that fits the `tool` matcher, its place among the calls, and the result that answers it. */
interface Run {
  at: number;
  call: ToolCall;
  result: TranscriptEvent | undefined;
}

/**
 * Finds the calls that fit a matcher with their results.
 * @param events - The run's events.
 * @param tool - What a call must be; absent for every call.
 * @returns The calls in order, each with its position among the calls and its result, if the stream carried one.
 */
function runsOf(
  events: TranscriptEvent[],
  tool: ToolMatcher | undefined,
): Run[] {
  const all = callsOf(events);
  const results = resultsByCall(events);
  const at = tool ? hitsOf(all, tool) : all.map((_, position) => position);
  return at.map((position) => ({
    at: position,
    call: all[position] as ToolCall,
    result: results.get(position),
  }));
}

/**
 * Chooses the calls that a `which` counts.
 * @param runs - Every call that fits the matcher.
 * @param which - Default: "any".
 * @returns All of them, the first, or the last.
 */
function chosen(runs: Run[], which: RuledCheck["which"]): Run[] {
  if (which === "first") return runs.slice(0, 1);
  return which === "last" ? runs.slice(-1) : runs;
}

const noCall = (outcome: Outcome, tool: ToolMatcher): Verdict => ({
  score: 0,
  reason: `no call matches ${describeMatcher(tool)}\n${quoteCalls(outcome.toolCalls, [])}`,
});

/** The calls a `tool_output_*` check looks at, and its compiled pattern. */
interface Picked {
  picked: Run[];
  fits: (text: string) => boolean;
}

/**
 * Finds the calls a `tool_output_matches` or `tool_output_lacks` check looks at.
 * @param check - The check, whose `tool`, `which`, `pattern` and `flags` are read.
 * @param outcome - What the run left behind.
 * @returns The chosen calls with their compiled pattern, or the failing verdict when no call fits `tool`.
 */
function pick(check: RuledCheck, outcome: Outcome): Picked | Verdict {
  const tool = check.tool as ToolMatcher;
  const runs = runsOf(outcome.transcript, tool);
  if (runs.length === 0) return noCall(outcome, tool);
  return {
    picked: chosen(runs, check.which),
    fits: tester(check.pattern, check.flags),
  };
}

/**
 * Lists the chosen calls whose output matches.
 * @param found - The chosen calls and the pattern.
 * @param found.picked - The chosen calls.
 * @param found.fits - The compiled pattern.
 * @returns The calls with an output that the pattern matches, each with that output as a piece.
 */
const hitsIn = ({ picked, fits }: Picked): (Run & { piece: Piece })[] =>
  picked.flatMap((run) => {
    const { result } = run;
    return result?.output !== undefined && fits(result.output)
      ? [{ ...run, piece: { event: result, text: result.output } }]
      : [];
  });

/**
 * Scores `tool_output_matches`.
 * @param check - The check, whose `tool`, `which`, `pattern` and `flags` are read.
 * @param outcome - What the run left behind.
 * @returns 1 when the output of a chosen call matches. A call with no result does not match.
 */
function outputMatches(check: RuledCheck, outcome: Outcome): Verdict {
  const found = pick(check, outcome);
  if ("score" in found) return found;
  if (hitsIn(found).length > 0) return PASS;
  const silent =
    check.which === undefined || check.which === "any"
      ? undefined
      : found.picked.find(({ result }) => result?.output === undefined);
  if (silent) {
    return { score: 0, reason: `call #${String(silent.at)} has no output` };
  }
  const shown = found.picked.flatMap(({ result }) =>
    result?.output === undefined
      ? []
      : [{ event: result, text: result.output }],
  );
  const which =
    check.which === undefined || check.which === "any"
      ? "any of the matching calls"
      : `the ${check.which} matching call`;
  return {
    score: 0,
    reason: `no output of ${which} matches ${written(check)}${shown.length === 0 ? ": none has an output" : `\n${quotePieces(shown)}`}`,
  };
}

/**
 * Scores `tool_output_lacks`.
 * @param check - The check, whose `tool`, `which`, `pattern` and `flags` are read.
 * @param outcome - What the run left behind.
 * @returns 1 when no chosen call's output matches. A call with no result cannot be shown to lack the pattern, and
 *   no call that fits the matcher fails too.
 */
function outputLacks(check: RuledCheck, outcome: Outcome): Verdict {
  const found = pick(check, outcome);
  if ("score" in found) return found;
  const hit = hitsIn(found);
  if (hit.length > 0) {
    return {
      score: 0,
      reason: `an output of call #${String(hit[0]?.at)} matches ${written(check)}\n${quotePieces(hit.map(({ piece }) => piece))}`,
    };
  }
  const silent = found.picked.find(
    ({ result }) => result?.output === undefined,
  );
  if (!silent) return PASS;
  return {
    score: 0,
    reason: `call #${String(silent.at)} has no output, so it cannot be shown to lack the pattern`,
  };
}

/**
 * Scores `tool_output_size`.
 * @param check - The check, whose `maxBytes` and `tool` are read.
 * @param outcome - What the run left behind.
 * @returns 1 when no output is over `maxBytes`. A call with no result is ignored.
 */
function outputSize(check: RuledCheck, outcome: Outcome): Verdict {
  const max = check.maxBytes as number;
  const results = check.tool
    ? runsOf(outcome.transcript, check.tool).flatMap(
        ({ result }) => result ?? [],
      )
    : outcome.transcript.filter((one) => one.type === "tool_result");
  const size = (one: TranscriptEvent): number =>
    one.bytes ?? Buffer.byteLength(one.output ?? "");
  const over = results.filter(
    (one) => one.output !== undefined && size(one) > max,
  );
  if (over.length === 0) return PASS;
  const lines = over
    .slice(0, SHOWN_LINES)
    .map((one) => `${quoteEvent(one)} (${String(size(one))} bytes)`);
  return {
    score: 0,
    reason: `${String(over.length)} ${over.length === 1 ? "output is" : "outputs are"} over ${String(max)} bytes\n${lines.join("\n")}`,
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
      "None of the tested texts matches the regular expression. A run with no events of the chosen `where` at all (no assistant text, no tool results, no calls) scores 0, since that usually means the capture is broken. An empty window after a found `before` or `after` cut passes, and a cut whose matcher matches no call scores 0.",
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
