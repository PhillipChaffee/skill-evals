import type { Mode } from "./checks/fields.js";
import type { Check } from "./checks/index.js";
import { CHECKS, readCheck } from "./checks/index.js";
import { UsageError } from "./scope.js";

/**
 * Lists the check types that a case may list under `preconditions`.
 * @returns The types whose spec says `precondition: true`, sorted.
 */
export const preconditionTypes = (): string[] =>
  Object.entries(CHECKS)
    .filter(([, spec]) => spec.precondition === true)
    .map(([type]) => type)
    .sort();

/**
 * Reads the `preconditions` of a case file.
 * @param raw - The case file.
 * @param file - The case file's name, for the message.
 * @param mode - Whether a key a check does not take is an error or is dropped with a warning.
 * @returns The checks, empty when the key is left out.
 * @throws {UsageError} When the key is not a non-empty list of checks, or a check is of a type that no precondition may
 *   be: a precondition says what the run started with, and only a type that reads that can be one.
 */
export function readPreconditions(
  raw: Record<string, unknown>,
  file: string,
  mode: Mode,
): Check[] {
  const given = raw["preconditions"];
  if (given === undefined) return [];
  if (!Array.isArray(given) || given.length === 0) {
    throw new UsageError(`${file}: "preconditions" must be a non-empty array`);
  }
  return given.map((one: unknown, index) => {
    const where = `${file} preconditions[${String(index)}]`;
    for (const key of ["weight", "ifUnsupported"]) {
      if ((one as Record<string, unknown> | null)?.[key] !== undefined) {
        throw new UsageError(
          `${where}: a precondition takes no "${key}": it never counts in the score and is never skipped`,
        );
      }
    }
    const check = readCheck(one, where, mode);
    if (CHECKS[check.type]?.precondition !== true) {
      throw new UsageError(
        `${where}: ${check.type} cannot be a precondition; allowed: ${preconditionTypes().join(", ")}`,
      );
    }
    return check;
  });
}
