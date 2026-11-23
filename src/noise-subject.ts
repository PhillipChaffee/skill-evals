import type { SubjectSummary } from "./subject.js";
import { UsageError, isObject } from "./scope.js";

/** The subject that `calibrate` ran against itself, as `noise.json` records it. */
export interface NoiseSubject {
  /** The subject as the user named it: "none", a directory as an absolute path, or a git ref. */
  label: string;
  /** The options of its spec in one canonical text, such as `hooks=off`; null for none. */
  options: string | null;
}

/**
 * Names a resolved subject the way `noise.json` records it.
 * @param subject - A resolved subject.
 * @returns Its label, a directory as the absolute path it resolved to so that the cwd does not matter, and its options.
 */
export const noiseSubjectOf = (subject: SubjectSummary): NoiseSubject => ({
  label:
    subject.commit === null && subject.dir !== null
      ? subject.dir
      : subject.spec,
  // A resolved subject with no options holds an empty text; its summary in the results leaves the key out.
  options:
    subject.options === undefined || subject.options === ""
      ? null
      : subject.options,
});

/**
 * Reads the `subject` of a noise file.
 * @param file - Where the noise file is, for a message.
 * @param value - What the file holds under `subject`.
 * @returns The calibrated subject, as read.
 * @throws {UsageError} Unless it is an object of exactly a string `label` and a string or null `options`.
 */
export function readNoiseSubject(file: string, value: unknown): NoiseSubject {
  const keys = isObject(value) ? Object.keys(value).sort().join() : "";
  if (
    !isObject(value) ||
    keys !== "label,options" ||
    typeof value["label"] !== "string" ||
    !(value["options"] === null || typeof value["options"] === "string")
  ) {
    throw new UsageError(
      `${file}: "subject" must be an object with a string "label" and a string or null "options"`,
    );
  }
  return value as unknown as NoiseSubject;
}

/**
 * Warns when the noise file was calibrated on a subject that the command does not run: the noise of one subject need
 * not be another's.
 * @param noise - The noise file and its path; null for none.
 * @param subjects - The command's subjects, resolved.
 */
export function warnNoiseSubject(
  noise: { file: string; noise: { subject?: NoiseSubject } } | null,
  subjects: SubjectSummary[],
): void {
  const calibrated = noise?.noise.subject;
  if (noise === null || calibrated === undefined) return;
  const same = subjects.some((subject) => {
    const own = noiseSubjectOf(subject);
    return own.label === calibrated.label && own.options === calibrated.options;
  });
  if (same) return;
  const options =
    calibrated.options === null ? "" : ` with ${calibrated.options}`;
  console.error(
    `skill-evals: warning: ${noise.file} was calibrated on the subject ${calibrated.label}${options}, which this command does not run, so its noise may not fit`,
  );
}
