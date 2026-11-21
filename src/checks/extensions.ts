import { UsageError } from "../scope.js";
import type { FieldAt, Mode } from "./fields.js";

/**
 * Finds the keys of an object that a case author may not use.
 * @param allowed - The keys the object may have.
 * @param at - Where the object is; its `siblings` are the object.
 * @param mode - Whether to fail or to drop the key and warn.
 * @returns The keys that start with `x-` and their values, which belong to the author. In lenient mode an unknown key
 *   is dropped from the result, and `mode.warn` hears of it.
 * @throws {UsageError} In strict mode, for a key that is not allowed and does not start with `x-`.
 */
export function extensionsOf(
  allowed: string[],
  at: FieldAt,
  mode: Mode,
): Record<string, unknown> {
  const extensions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(at.siblings)) {
    if (allowed.includes(key)) continue;
    if (key.startsWith("x-")) {
      extensions[key] = value;
    } else if (mode.lenient) {
      mode.warn?.(`${at.where}: ignored unknown key "${key}"`);
    } else {
      throw new UsageError(
        `${at.where}: unknown key "${key}" for ${at.owner}; allowed: ${allowed.join(", ")}`,
      );
    }
  }
  return extensions;
}
