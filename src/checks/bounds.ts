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

/**
 * Refuses a count whose `min` is 0 and that has no `max`, which no run can fail.
 * @param given - The fields that are set.
 * @param where - Names the file and the check in an error message.
 * @throws {UsageError} When `min` is 0 and `max` is absent.
 */
export function checkOpenMin(
  given: Record<string, unknown>,
  where: string,
): void {
  if (given["min"] === 0 && given["max"] === undefined) {
    throw new UsageError(
      `${where}: "min" 0 with no "max" passes every run; set "max", or drop "min"`,
    );
  }
}

/**
 * Checks that the line bounds and the duration bounds of a call matcher can be met.
 * @param given - The fields that are set.
 * @param where - Names the file and the check in an error message.
 * @throws {UsageError} When `inputLinesMin` is above `inputLinesMax`, or `minDurationMs` above `maxDurationMs`.
 */
export function checkLineBounds(
  given: Record<string, unknown>,
  where: string,
): void {
  const { inputLinesMin: low, inputLinesMax: high } = given;
  if (typeof low === "number" && typeof high === "number" && low > high) {
    throw new UsageError(
      `${where}: "inputLinesMin" ${String(low)} is above "inputLinesMax" ${String(high)}`,
    );
  }
  const { minDurationMs: slow, maxDurationMs: fast } = given;
  if (typeof slow === "number" && typeof fast === "number" && slow > fast) {
    throw new UsageError(
      `${where}: "minDurationMs" ${String(slow)} is above "maxDurationMs" ${String(fast)}`,
    );
  }
}
