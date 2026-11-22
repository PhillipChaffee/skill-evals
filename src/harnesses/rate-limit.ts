// What a provider's own error text says when it limits the rate of requests or is overloaded, as the providers word
// it: an HTTP status with its reason, a status field, or an error type. A bare number does not count, because a stack
// position such as `cli.js:429:17` has one, and neither does a module path such as `rate-limit/index.js`. The wording
// is taken from the providers' documented errors and has not been checked against a real run of any harness.
const RATE_LIMITED = new RegExp(
  [
    String.raw`\b429 too many requests\b`,
    String.raw`\b529 overloaded\b`,
    String.raw`\bstatus[: =]+(?:429|529)\b(?!:\d)`,
    String.raw`\bhttp (?:status )?(?:429|529)\b(?!:\d)`,
    String.raw`\brate_limit_error\b`,
    String.raw`\boverloaded_error\b`,
    String.raw`\brate limit (?:reached|exceeded)\b`,
  ].join("|"),
  "i",
);

/**
 * Tells whether the error of a run says that the provider limited the rate of requests, or was overloaded. A run
 * that failed this way is worth trying again after a wait.
 * @param error - The error of a finished run: the harness's own message, or why the process failed.
 * @returns True when the text has a provider-shaped rate limit or overload message; false for a stack trace or a path.
 */
export const looksRateLimited = (error: string): boolean =>
  RATE_LIMITED.test(error);
