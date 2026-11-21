import { UsageError } from "./scope.js";

/** The key that points an editor at the JSON Schema of a file. A case file and the config file may carry it. */
export const SCHEMA_KEY = "$schema";

/**
 * Checks the `$schema` key of a file, which nothing reads but the editor.
 * @param file - The file, for the message.
 * @param object - The file's top-level object.
 * @throws {UsageError} When the key is present and is not a string.
 */
export function checkSchemaKey(
  file: string,
  object: Record<string, unknown>,
): void {
  const given = object[SCHEMA_KEY];
  if (given !== undefined && typeof given !== "string") {
    throw new UsageError(`${file}: "${SCHEMA_KEY}" must be a string`);
  }
}
