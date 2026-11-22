// What the error text of a rate-limited or overloaded provider says, as the adapters' CLIs word it. The wording is taken
// from the providers' documented errors and has not been checked against a real run of any harness.
const RATE_LIMITED =
  /rate[ _-]?limit|too many requests|\b429\b|overloaded|\b529\b/i;

/**
 * Tells whether the error of a run says that the provider limited the rate of requests, or was overloaded. A run
 * that failed this way is worth trying again after a wait.
 * @param error - The error of a finished run: the harness's own message, or why the process failed.
 * @returns True when the text names a rate limit, HTTP 429 or 529, or an overload.
 */
export const looksRateLimited = (error: string): boolean =>
  RATE_LIMITED.test(error);
