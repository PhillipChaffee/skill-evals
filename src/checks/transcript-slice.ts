import type { By } from "../agents.js";
import { fitsBy } from "../agents.js";
import type { ToolMatcher } from "../matchers.js";
import { describeMatcher, hitsOf } from "../matchers.js";
import type { TranscriptEvent } from "../harnesses/shared.js";
import { callsOf } from "../transcript.js";
import type { Where } from "./transcript-fields.js";

/**
 * Which events of the transcript a check tests. The words and the matcher forms are the ones the `scope` field loads.
 */
export type Scope =
  | "first_message"
  | "final_message"
  | "any"
  | { before: ToolMatcher }
  | { after: ToolMatcher }
  | { first_message: true; before: ToolMatcher };

/** A text to test and the event it came from. */
export interface Piece {
  event: TranscriptEvent;
  text: string;
}

/** What a scope and a `where` give: the texts, or why the check cannot be scored. */
export type Sliced =
  { pieces: Piece[]; window: TranscriptEvent[] } | { problem: string };

/** The most characters of one event that a pattern sees. */
const TEXT_CAP = 1_000_000;
const QUOTE_WIDTH = 120;

/**
 * Quotes one event the way a reason names it.
 * @param event - Any event.
 * @param text - What to show of it; default: its text, output or input.
 * @returns `#<index> <type> <first 120 characters>`, on one line.
 */
export function quoteEvent(event: TranscriptEvent, text?: string): string {
  const shown =
    text ?? event.text ?? event.output ?? JSON.stringify(event.input ?? null);
  const flat = shown.slice(0, QUOTE_WIDTH).replace(/\s+/g, " ");
  return `#${String(event.index)} ${event.type} ${flat}`;
}

/**
 * Quotes some pieces, one line each.
 * @param pieces - The texts that a reason is about.
 * @param limit - The most lines. Default: 5.
 * @returns One line per piece and a line that counts the rest; "(no text)" for none.
 */
export function quotePieces(pieces: Piece[], limit = 5): string {
  if (pieces.length === 0) return "(no text)";
  const lines = pieces
    .slice(0, limit)
    .map(({ event, text }) => quoteEvent(event, text));
  const left = pieces.length - lines.length;
  return (left > 0 ? [...lines, `... ${String(left)} more`] : lines).join("\n");
}

// The assistant texts of the agents `by` names that say something, in order. No `by` is the main agent.
const spoken = (events: TranscriptEvent[], by?: By): TranscriptEvent[] =>
  events.filter(
    (one) =>
      one.type === "text" &&
      one.role === "assistant" &&
      fitsBy(by ?? "main", one.agent) &&
      (one.text ?? "").trim() !== "",
  );

/**
 * Finds the first call that fits a matcher.
 * @param events - The run's events.
 * @param matcher - What the call must be.
 * @returns Its position in `events` and its position among the calls, or null when no call fits.
 */
function firstCall(
  events: TranscriptEvent[],
  matcher: ToolMatcher,
): { at: number; call: number } | null {
  const [call] = hitsOf(callsOf(events), matcher);
  if (call === undefined) return null;
  let seen = -1;
  const at = events.findIndex((one) => {
    seen += one.type === "tool_call" ? 1 : 0;
    return seen === call;
  });
  return { at, call };
}

/** The calls that bound a `first_message`, and the run's number of the first call of the events. */
interface Bound {
  matcher: ToolMatcher;
  callBase: number;
}

/**
 * Tests the bounded form of `first_message`.
 * @param events - The run's events.
 * @param first - The first non-empty text of the agent the check names, if any.
 * @param bound - The calls that must not come before it, and the run's number of the first call of `events`.
 * @returns That text alone, or why it cannot be tested: there is none, or it comes after the matcher's first call.
 */
function boundedFirst(
  events: TranscriptEvent[],
  first: TranscriptEvent | undefined,
  bound: Bound,
): { events: TranscriptEvent[] } | { problem: string } {
  if (!first) return { problem: "no assistant text" };
  const { matcher, callBase } = bound;
  const cut = firstCall(events, matcher);
  if (cut && events.indexOf(first) > cut.at) {
    return {
      problem: `the first assistant text comes after the first call to ${describeMatcher(matcher)} (call #${String(cut.call + callBase)})\n${quoteEvent(first)}`,
    };
  }
  return { events: [first] };
}

/**
 * Cuts the events a scope names.
 * @param events - The run's events.
 * @param cut - Which events to keep (`scope`), and whose first or last message the message scopes read (`by`; default: the main agent).
 * @returns The events, or the reason the scope holds none that a check can test.
 */
function scoped(
  events: TranscriptEvent[],
  cut: Cut,
): { events: TranscriptEvent[] } | { problem: string } {
  const { scope, by } = cut;
  if (scope === "any") return { events };
  const texts = spoken(events, by);
  if (typeof scope === "string") {
    const one = scope === "first_message" ? texts[0] : texts.at(-1);
    return one ? { events: [one] } : { problem: "no assistant text" };
  }
  if ("first_message" in scope)
    return boundedFirst(events, texts[0], {
      matcher: scope.before,
      callBase: cut.callBase ?? 0,
    });
  const side = "before" in scope ? "before" : "after";
  const matcher = "before" in scope ? scope.before : scope.after;
  const hit = firstCall(events, matcher);
  if (!hit) {
    return {
      problem: `no call matches ${describeMatcher(matcher)}, so nothing is ${side} it`,
    };
  }
  return {
    events:
      side === "before" ? events.slice(0, hit.at) : events.slice(hit.at + 1),
  };
}

/**
 * Takes the text of one event.
 * @param one - Any event.
 * @param where - What the check tests.
 * @returns The event's text, input as JSON, or output, as `where` asks, cut to the cap; undefined when it holds none.
 */
function textOf(one: TranscriptEvent, where: Where): string | undefined {
  const [form, text]: [Where | undefined, string | undefined] =
    one.type === "text" && one.role === "assistant"
      ? ["assistant_text", one.text]
      : one.type === "tool_call"
        ? ["tool_input", JSON.stringify(one.input ?? null)]
        : one.type === "tool_result"
          ? ["tool_output", one.output]
          : [undefined, undefined];
  return where === "all" || where === form
    ? text?.slice(0, TEXT_CAP)
    : undefined;
}

/** What a check tests: which events, which text of them, and whose. */
export interface Cut {
  /** Which events to look at. */
  scope: Scope;
  /** What to take from them. */
  where: Where;
  /** Whose events to keep, after the scope has cut them; the message scopes read the first or last text of these agents, and the main agent without `by`. */
  by?: By | undefined;
  /** The run's number of the first call of `events`, so that a reason names a call as `show` does. Default: 0. */
  callBase?: number | undefined;
}

/**
 * Picks the texts a check tests.
 * @param events - The run's events.
 * @param cut - The scope, what to take, and whose.
 * @returns The texts, each with its event and cut to the first million characters; or the reason the scope cannot
 *   be applied: no assistant text, no call that fits a `before` or `after` matcher, or a first text that comes after
 *   the bounding call.
 */
export function pieces(events: TranscriptEvent[], cut: Cut): Sliced {
  const { where, by } = cut;
  const scopedEvents = scoped(events, cut);
  if ("problem" in scopedEvents) return scopedEvents;
  const window =
    by === undefined
      ? scopedEvents.events
      : scopedEvents.events.filter((one) => fitsBy(by, one.agent));
  return {
    window,
    pieces: window.flatMap((event) => {
      const text = textOf(event, where);
      return text === undefined ? [] : [{ event, text }];
    }),
  };
}

/**
 * Picks the texts a check tests.
 * @param events - The run's events.
 * @param scope - Which events to look at.
 * @param where - What to take from them.
 * @returns The texts; none when the scope cannot be applied, which `pieces` says why.
 */
export const slice = (
  events: TranscriptEvent[],
  scope: Scope,
  where: Where,
): string[] => {
  const cut = pieces(events, { scope, where });
  return "pieces" in cut ? cut.pieces.map(({ text }) => text) : [];
};
