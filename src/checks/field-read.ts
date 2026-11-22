import { UsageError, isObject } from "../scope.js";
import type { FieldAt, FieldParser } from "./fields.js";

/**
 * Reads a value that must be a non-empty string.
 * @param value - The parsed value.
 * @param at - Where it is, and what it is.
 * @param at.name - The key.
 * @returns The string.
 * @throws {UsageError} When the value is not a non-empty string.
 */
export function text(value: unknown, at: FieldAt & { name: string }): string {
  if (typeof value !== "string" || value === "") {
    throw new UsageError(
      `${at.where}: ${at.owner} needs a string "${at.name}"`,
    );
  }
  return value;
}

/**
 * Makes the error of a value that does not fit its field.
 * @param at - Where the value is.
 * @param problem - What is wrong with it.
 * @returns A usage error that names the file, the check or case, and the problem.
 */
export const failure = (at: FieldAt, problem: string): UsageError =>
  new UsageError(`${at.where}: ${problem}`);

/**
 * Makes the parser of a number from `low` to 1.
 * @param low - The least value allowed.
 * @returns The parser.
 */
export const ranged =
  (low: number): FieldParser =>
  /**
   * Reads a number.
   * @param value - The parsed value.
   * @param at - Where it is.
   * @returns The number.
   */
  (value, at) => {
    if (!(typeof value === "number" && value >= low && value <= 1)) {
      throw failure(at, `${at.name} must be a number from ${String(low)} to 1`);
    }
    return value;
  };

/**
 * Makes the parser of a whole number from `low` up.
 * @param low - The least value allowed.
 * @param wording - What the error says the value must be.
 * @returns The parser.
 */
export const whole =
  (low: number, wording: string): FieldParser =>
  /**
   * Reads a whole number.
   * @param value - The parsed value.
   * @param at - Where it is.
   * @returns The number.
   */
  (value, at) => {
    if (!(
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= low
    )) {
      throw failure(at, `${at.name} must be ${wording}`);
    }
    return value;
  };

/**
 * Reads a list of objects.
 * @param value - The parsed value.
 * @param at - Where it is.
 * @returns The list.
 */
export const objects: FieldParser = (value, at) => {
  if (!Array.isArray(value) || !value.every(isObject)) {
    throw failure(at, `"${at.name}" must be a list of objects`);
  }
  return value;
};

/**
 * Reads a non-empty list of objects.
 * @param value - The parsed value.
 * @param at - Where it is.
 * @returns The list.
 */
export const nonEmptyObjects: FieldParser = (value, at) => {
  if (Array.isArray(value) && value.length === 0) {
    throw failure(at, `"${at.name}" must not be empty`);
  }
  return objects(value, at);
};
