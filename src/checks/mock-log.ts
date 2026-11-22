import { normalizeAgent } from "../agents.js";
import { matchersOf } from "./by-needs.js";
import type { Check, Outcome } from "./index.js";

/** What a check on tool calls says of a run whose MCP calls come from the mock log. */
export type MockLogVerdict =
  { score: 0; reason: string } | { score: null; reason: string };

const ORDERED = ["tool_order", "first_tool"];

/**
 * Tells whether a check can be scored on a run that holds calls only the mock log showed. Such a call has no known
 * agent, no turn and no place among the stream's calls.
 * @param check - Any check of the case.
 * @param outcome - What the run left behind.
 * @returns Undefined when the run has no such call, or the check does not look at who made a call or when. Otherwise
 *   a verdict that makes the check unscored (so the run is invalid) for an order, a first call, a turn or a check scoped to a user turn, and score 0 for
 *   a `by` that names anyone but `{ agent: "unknown" }`: such a check must not pass because the log cannot say who
 *   made the call.
 */
export function mockLogVerdict(
  check: Check,
  outcome: Pick<Outcome, "toolCalls">,
): MockLogVerdict | undefined {
  if (!outcome.toolCalls.some((call) => call.source === "mock-log")) {
    return undefined;
  }
  if (
    ORDERED.includes(check.type) ||
    check.first ||
    check.sameTurn ||
    check.turn !== undefined
  ) {
    return {
      score: null,
      reason:
        "the order, first place or turn of a call of the mock log cannot be determined",
    };
  }
  const bys = [check.by, ...matchersOf(check).map((one) => one.by)];
  const named = bys.some(
    (by) =>
      by !== undefined &&
      !(typeof by === "object" && normalizeAgent(by.agent) === "unknown"),
  );
  return check.type.startsWith("tool_") && named
    ? { score: 0, reason: "mock-log calls have no known agent" }
    : undefined;
}
