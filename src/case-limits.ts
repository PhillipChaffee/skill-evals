import { HARNESSES } from "./harnesses/index.js";
import { UsageError } from "./scope.js";

/** Reads one key of a case file with its type's parser; undefined when the file leaves the key out. */
type Read = (key: string) => unknown;

/**
 * Reads the harnesses that a case is limited to.
 * @param read - Reads a key of the case file.
 * @param file - The case file, for the messages.
 * @returns The harness ids and the note, both absent for a case that is for every harness.
 * @throws {UsageError} When a harness id is unknown, or `harnesses` has no `note`.
 */
export function limitsOf(read: Read, file: string) {
  const harnesses = read("harnesses") as string[] | undefined;
  const note = read("note") as string | undefined;
  if (harnesses) {
    const known = HARNESSES.map((harness) => harness.id);
    const unknown = harnesses.find((id) => !known.includes(id));
    if (unknown !== undefined) {
      throw new UsageError(
        `${file}: unknown harness "${unknown}"; known: ${known.join(", ")}`,
      );
    }
    if (note === undefined) {
      throw new UsageError(
        `${file}: "harnesses" needs a "note" that says why the case is limited`,
      );
    }
  }
  return { harnesses, note };
}
