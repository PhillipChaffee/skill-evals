import type { Case } from "../cases.js";
import { allChecks } from "../case-checks.js";
import { matchersOf } from "../checks/by-needs.js";
import type { Lint } from "./validate.js";

/**
 * Warns about matchers that can never fit a call: `dispatches` fits a `subagent` call only, so a `kind` beside it that
 * is anything else rules out every call.
 * @param cases - The loaded cases.
 * @returns One warning for each check, its own fields or a matcher in it, that sets `dispatches` with such a `kind`.
 */
export function dispatchKinds(cases: Case[]): Lint[] {
  return cases.flatMap((one) =>
    allChecks(one).flatMap((check) =>
      [check, ...matchersOf(check)]
        .filter(
          (matcher) =>
            matcher.dispatches !== undefined &&
            matcher.kind !== undefined &&
            matcher.kind !== "subagent",
        )
        .map((matcher): Lint => ({
          level: "warning",
          caseId: one.id,
          text: `a ${check.type} check has a matcher with kind "${String(matcher.kind)}" and dispatches "${String(matcher.dispatches)}", which can never match: dispatches fits only a call of kind "subagent"`,
        })),
    ),
  );
}
