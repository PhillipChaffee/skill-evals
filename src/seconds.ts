import { UsageError } from "./scope.js";

export const MS_PER_SECOND = 1000;
// The longest time limit a timer takes is 2^32 - 1 milliseconds.
const MAX_TIMEOUT_SECONDS = 4_294_967;

/**
 * Rejects a time limit that no timer takes.
 * @param name - The option's name, for the message.
 * @param seconds - The value.
 * @throws {UsageError} When it is not a positive integer of seconds that a timer takes.
 */
export function requireSeconds(name: string, seconds: number): void {
  if (!(
    Number.isInteger(seconds) &&
    seconds >= 1 &&
    seconds <= MAX_TIMEOUT_SECONDS
  )) {
    throw new UsageError(
      `${name} must be a positive integer of seconds, at most ${String(MAX_TIMEOUT_SECONDS)}`,
    );
  }
}
