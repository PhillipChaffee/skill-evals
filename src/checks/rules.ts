import type { Field, Rule, Spec, Test, With } from "./index.js";

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
 * Makes a check type whose rule scores 1 when a test holds, 0 when it does not.
 * @param fields - The fields the check requires. Loading a case reads each with its type's parser, which is what lets
 *   the test use them as set.
 * @param test - Looks at the check and the outcome.
 * @param more - What the spec says besides its fields and rule.
 * @returns The spec.
 */
export const holds = <F extends Field>(
  fields: F[],
  test: Test<F>,
  more: Omit<Spec, "fields" | "rule">,
): Spec & { rule: Rule } => ({
  fields,
  ...more,
  rule: (check, outcome) => ({
    score: Number(test(check as With<F>, outcome)),
  }),
});

/**
 * Makes a check type whose rule scores 1 when a test does not hold, 0 when it does.
 * @param fields - The fields the check requires.
 * @param test - Looks at the check and the outcome.
 * @param more - What the spec says besides its fields and rule.
 * @returns The spec.
 */
export const fails = <F extends Field>(
  fields: F[],
  test: Test<F>,
  more: Omit<Spec, "fields" | "rule">,
): Spec & { rule: Rule } =>
  holds(fields, (check, outcome) => !test(check, outcome), more);
