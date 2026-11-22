import type { Capability } from "../capabilities.js";
import type { ToolCall, TranscriptEvent } from "../harnesses/shared.js";
import type { ToolMatcher } from "../matchers.js";
import { describeMatcher, hitsOf, quoteCalls, tester } from "../matchers.js";
import { callsOf, resultsByCall } from "../transcript.js";
import type { Check, Outcome, RuledCheck, Spec, Verdict } from "./index.js";
import { PASS } from "./rules.js";
import type { Piece } from "./transcript-slice.js";
import { pieces, quoteEvent, quotePieces } from "./transcript-slice.js";
import "./transcript-scope.js";

const SHOWN_LINES = 5;
const FIELDS_OF_TEXT = { optional: ["flags", "where", "scope"] };
const CAP_NOTE =
  "A pattern sees at most the first 1,000,000 characters of each event. `first_message` is the main agent's first non-empty text, which in a kit whose first action is a tool call is not the text before the first tool call. `by` is not yet supported.";

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
 * @returns 1 when no tested text matches.
 */
function textLacks(check: RuledCheck, outcome: Outcome): Verdict {
  const found = tested(check, outcome);
  if ("problem" in found) return { score: 0, reason: found.problem };
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

/**
 * Scores `tool_output_matches`.
 * @param check - The check, whose `pattern`, `flags` and the fields of its type are read.
 * @param outcome - What the run left behind.
 * @returns 1 when the output of a chosen call matches. A call with no result does not match.
 */
function outputMatches(check: RuledCheck, outcome: Outcome): Verdict {
  const tool = check.tool as ToolMatcher;
  const runs = runsOf(outcome.transcript, tool);
  if (runs.length === 0) return noCall(outcome, tool);
  const fits = tester(check.pattern, check.flags);
  const picked = chosen(runs, check.which);
  if (
    picked.some(
      ({ result }) => result?.output !== undefined && fits(result.output),
    )
  ) {
    return PASS;
  }
  const silent =
    check.which === "any"
      ? undefined
      : picked.find(({ result }) => result?.output === undefined);
  if (silent)
    return { score: 0, reason: `call #${String(silent.at)} has no output` };
  const shown = picked.flatMap(({ result }) =>
    result?.output === undefined
      ? []
      : [{ event: result, text: result.output }],
  );
  return {
    score: 0,
    reason: `no output of the ${check.which ?? "any"} matching call matches ${written(check)}\n${quotePieces(shown)}`,
  };
}

/**
 * Scores `tool_output_lacks`.
 * @param check - The check, whose `pattern`, `flags` and the fields of its type are read.
 * @param outcome - What the run left behind.
 * @returns 1 when no chosen call's output matches. A call with no result cannot be shown to lack the pattern, and
 *   no call that fits the matcher fails too.
 */
function outputLacks(check: RuledCheck, outcome: Outcome): Verdict {
  const tool = check.tool as ToolMatcher;
  const runs = runsOf(outcome.transcript, tool);
  if (runs.length === 0) return noCall(outcome, tool);
  const fits = tester(check.pattern, check.flags);
  const picked = chosen(runs, check.which);
  const hit = picked.filter(
    ({ result }) => result?.output !== undefined && fits(result.output),
  );
  if (hit.length > 0) {
    const shown = hit.map(({ result }) => ({
      event: result as TranscriptEvent,
      text: (result as TranscriptEvent).output as string,
    }));
    return {
      score: 0,
      reason: `an output of call #${String(hit[0]?.at)} matches ${written(check)}\n${quotePieces(shown)}`,
    };
  }
  const silent = picked.find(({ result }) => result?.output === undefined);
  if (!silent) return PASS;
  return {
    score: 0,
    reason: `call #${String(silent.at)} has no output, so it cannot be shown to lack the pattern`,
  };
}

/**
 * Scores `tool_output_size`.
 * @param check - The check, whose `pattern`, `flags` and the fields of its type are read.
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
    needs: textNeeds,
    scores:
      "None of the tested texts matches the regular expression. A `scope` that holds no text to test, such as `first_message` of a run with no assistant text, scores 0.",
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
