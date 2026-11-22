import { EXIT } from "./exit-codes.js";
import { UsageError } from "./scope.js";

/**
 * Tells whether `parseArgs` refused the command line.
 * @param error - What a command threw.
 * @returns True for the errors that `parseArgs` raises, whose code starts with `ERR_PARSE_ARGS`.
 */
const isParseArgsError = (error: unknown): error is Error =>
  error instanceof Error &&
  "code" in error &&
  String(error.code).startsWith("ERR_PARSE_ARGS");

/**
 * Prints an internal error with its stack trace.
 * @param error - What was thrown or rejected.
 * @returns 5.
 */
function internal(error: unknown): number {
  console.error(
    `skill-evals: internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  return EXIT.error;
}

/**
 * Reports a failure of a command line.
 * @param error - What the command threw.
 * @returns 2 with one line on standard error for a usage error or a flag that `parseArgs` refused; else 5, with the
 *   stack trace on standard error.
 */
export function failed(error: unknown): number {
  if (error instanceof UsageError || isParseArgsError(error)) {
    console.error(`skill-evals: ${error.message}`);
    return EXIT.usage;
  }
  return internal(error);
}

/**
 * Reports a failure that nothing caught and ends the process with exit code 5, as `main` does for an internal error.
 * @param error - What was thrown or rejected.
 * @param end - Ends the process. Default: `process.exit`.
 */
export function onFatal(
  error: unknown,
  end: (code: number) => void = (code) => process.exit(code),
): void {
  end(internal(error));
}

/** Makes an uncaught exception and an unhandled rejection end the process with exit code 5, not 1. */
export function installFatalHandlers(): void {
  process.on("uncaughtException", (error) => {
    onFatal(error);
  });
  process.on("unhandledRejection", (reason) => {
    onFatal(reason);
  });
}
