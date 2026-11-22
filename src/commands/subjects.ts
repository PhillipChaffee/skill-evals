import { UsageError } from "../scope.js";
import { parseNamed, requireNamed } from "../subject-labels.js";
import type { Project } from "../project.js";

/** The subjects of a command, as `evaluate` takes them. */
export interface SubjectArgs {
  subjects: string[];
  /** The labels of `--subjects`; absent for the default labels. */
  labels?: string[];
}

/**
 * Turns the subject flags of a command into the subjects that `evaluate` runs.
 * @param given - `--a`, `--b`, `--subject` and `--subjects`, as typed.
 * @param given.a - The baseline of a comparison of two.
 * @param given.b - The change of a comparison of two.
 * @param given.subject - The one subject of a command that scores one.
 * @param given.subjects - `name=spec,name=spec,...`.
 * @param project - Where the default subject is.
 * @param scoresOne - True for a command that scores one subject when no flag says otherwise, as `plan` does.
 * @returns With `--subjects`, its specs and labels. Else the one subject, when `--a` and `--b` are both absent and
 *   `--subject` is given or the command scores one; else the baseline `main` and the project's working tree.
 * @throws {UsageError} When `--subjects` comes with `--a`, `--b` or `--subject`, or is not 2 to 8 `label=spec` pairs
 *   with distinct labels.
 */
export function subjectsOf(
  given: {
    a?: string | undefined;
    b?: string | undefined;
    subject?: string | undefined;
    subjects?: string | undefined;
  },
  project: Pick<Project, "root">,
  scoresOne = false,
): SubjectArgs {
  const { a, b, subject, subjects } = given;
  if (subjects !== undefined) {
    if (a !== undefined || b !== undefined || subject !== undefined) {
      throw new UsageError(
        "--subjects names every subject: it cannot be combined with --a, --b or --subject",
      );
    }
    const named = requireNamed(parseNamed(subjects));
    return {
      subjects: named.map((one) => one.spec),
      labels: named.map((one) => one.label),
    };
  }
  if (
    a === undefined &&
    b === undefined &&
    (scoresOne || subject !== undefined)
  ) {
    return { subjects: [subject ?? project.root] };
  }
  return { subjects: [a ?? "main", b ?? project.root] };
}
