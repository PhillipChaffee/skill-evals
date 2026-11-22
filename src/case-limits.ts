import type { FieldDef } from "./checks/fields.js";
import { HARNESSES } from "./harnesses/index.js";
import type { OnTimeout } from "./session-end.js";
import { UsageError } from "./scope.js";

/** Reads one key of a case file with its type's parser; undefined when the file leaves the key out. */
type Read = (key: string) => unknown;

// The keys that bound a run: how many turns, how long, and what a timeout means.
export const LIMIT_KEYS: Record<string, FieldDef> = {
  maxTurns: {
    type: "int",
    meaning:
      'The most turns the agent may take. A turn is one main-thread assistant turn; a subagent\'s turns do not count. The runner counts turns as the stream arrives and stops the run as turn `maxTurns + 1` begins, so a partial extra turn may show in the transcript; whatever was seen is kept. A run stopped this way is valid and scored, with `stoppedBy: "maxTurns"`, and its final text is the last thing the agent said. Claude Code also gets its own `--max-turns`. A harness that cannot count turns (no `turnGrouping`) records `maxTurnsEnforced: false`, and the report lists the case under "Limits not enforced".',
  },
  timeoutSeconds: {
    type: "int",
    meaning: "The seconds a run may take. Default: 600.",
  },
  onTimeout: {
    type: "enum",
    values: ["invalid", "score"],
    meaning:
      'What a run that hits `timeoutSeconds` is. "invalid" makes it an invalid run, as it always was. "score" scores it on what it left, with `stoppedBy: "timeout"`, for a case where stalling is the behaviour under test. Default: "invalid".',
  },
};

/**
 * Reads the harnesses that a case is limited to, and what its timeout means.
 * @param read - Reads a key of the case file.
 * @param file - The case file, for the messages.
 * @returns The harness ids and the note, both absent for a case that is for every harness, and `onTimeout`.
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
  const onTimeout = (read("onTimeout") as OnTimeout | undefined) ?? "invalid";
  return { harnesses, note, onTimeout };
}
