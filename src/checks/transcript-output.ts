import type { ToolCall, TranscriptEvent } from "../harnesses/shared.js";
import { valueOf } from "./defaults.js";
import type { ToolMatcher } from "../matchers.js";
import {
  callNo,
  describeMatcher,
  hitsOf,
  quoteCalls,
  tester,
} from "../matchers.js";
import { callsOf, resultsByCall } from "../transcript.js";
import type { Outcome, RuledCheck, Verdict } from "./index.js";
import { unseenAgent } from "./by-needs.js";
import { PASS } from "./rules.js";
import type { Piece } from "./transcript-slice.js";
import { quoteEvent, quotePieces } from "./transcript-slice.js";

const SHOWN_LINES = 5;
const written = (check: RuledCheck): string =>
  `/${check.pattern ?? ""}/${check.flags ?? ""}`;

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

const whichOf = (check: { type: string }): "first" | "last" | "any" =>
  valueOf(check, "which") as "first" | "last" | "any";

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
    picked: chosen(runs, whichOf(check)),
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
export function outputMatches(check: RuledCheck, outcome: Outcome): Verdict {
  const found = pick(check, outcome);
  if ("score" in found) return found;
  if (hitsIn(found).length > 0) return PASS;
  const silent =
    whichOf(check) === "any"
      ? undefined
      : found.picked.find(({ result }) => result?.output === undefined);
  if (silent) {
    return {
      score: 0,
      reason: `call #${callNo(outcome.toolCalls, silent.at)} has no output`,
    };
  }
  const shown = found.picked.flatMap(({ result }) =>
    result?.output === undefined
      ? []
      : [{ event: result, text: result.output }],
  );
  const which =
    whichOf(check) === "any"
      ? "any of the matching calls"
      : `the ${whichOf(check)} matching call`;
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
export function outputLacks(check: RuledCheck, outcome: Outcome): Verdict {
  const unseen = unseenAgent(check, outcome);
  if (unseen) return unseen;
  const found = pick(check, outcome);
  if ("score" in found) return found;
  const hit = hitsIn(found);
  if (hit.length > 0) {
    return {
      score: 0,
      reason: `an output of call #${callNo(outcome.toolCalls, hit[0]?.at ?? 0)} matches ${written(check)}\n${quotePieces(hit.map(({ piece }) => piece))}`,
    };
  }
  const silent = found.picked.find(
    ({ result }) => result?.output === undefined,
  );
  if (!silent) return PASS;
  return {
    score: 0,
    reason: `call #${callNo(outcome.toolCalls, silent.at)} has no output, so it cannot be shown to lack the pattern`,
  };
}

/**
 * Scores `tool_output_size`.
 * @param check - The check, whose `maxBytes` and `tool` are read.
 * @param outcome - What the run left behind.
 * @returns 1 when no output is over `maxBytes`. A call with no result is ignored.
 */
export function outputSize(check: RuledCheck, outcome: Outcome): Verdict {
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
