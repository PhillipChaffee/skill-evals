import { UsageError } from "../scope.js";

/**
 * Checks the fields of a count together.
 * @param given - The fields that are set.
 * @param where - Names the file and the check in an error message.
 * @throws {UsageError} When `min` is above `max`.
 */
export function checkBounds(
  given: Record<string, unknown>,
  where: string,
): void {
  const { min, max } = given;
  if (typeof min === "number" && typeof max === "number" && min > max) {
    throw new UsageError(
      `${where}: "min" ${String(min)} is above "max" ${String(max)}`,
    );
  }
}
