/**
 * The default `min` of a count: 1, and 0 when `max` is 0, which could never pass with a minimum of 1.
 * @param check - The fields the check sets.
 * @param check.max - The check's `max`, when set.
 * @returns The `min` that the rule applies.
 */
export const minOf = (check: { max?: number | undefined }): number =>
  check.max === 0 ? 0 : 1;
