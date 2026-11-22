import type { Case } from "./cases.js";
import { UsageError } from "./scope.js";

/** The fewest and the most subjects of `--subjects`. */
const MIN_NAMED = 2;
const MAX_NAMED = 8;

// A label ends in a letter, so that `<label><rep>` in a file name names one pair: `k` with rep 11 is never `k1` with rep 1.
const LABEL = /^[a-z]([a-z0-9-]*[a-z])?$/;
// The first words of the options of a spec: a label with one of these names would read as an option of the subject before it.
const OPTION_WORDS = ["hooks", "rules", "agents", "skills"];

/** A subject as `--subjects` names it. */
export interface NamedSubject {
  label: string;
  spec: string;
}

/**
 * Splits `--subjects name=spec,name=spec,...` into its subjects. A comma separates subjects, except inside braces and
 * before an option of the subject in front (`hooks=`, `rules=`, `agents=` or `skills=`), so that `lean=.:hooks=off,rules=on`
 * is one subject.
 * @param text - The flag's value.
 * @returns One entry for each subject, in order.
 * @throws {UsageError} For an item that is not `name=spec`.
 */
export function parseNamed(text: string): NamedSubject[] {
  const items: string[] = [];
  let depth = 0;
  let item = "";
  const flush = (): void => {
    const joins = OPTION_WORDS.some((word) =>
      item.trim().startsWith(`${word}=`),
    );
    const last = items.at(-1);
    if (joins && last !== undefined)
      items[items.length - 1] = `${last},${item}`;
    else items.push(item);
    item = "";
  };
  for (const char of text) {
    if (char === "{") depth++;
    else if (char === "}" && depth > 0) depth--;
    if (char === "," && depth === 0) flush();
    else item += char;
  }
  flush();
  return items.map((each) => {
    const at = each.indexOf("=");
    if (at <= 0 || at === each.length - 1) {
      throw new UsageError(
        `--subjects takes name=spec pairs; "${each.trim()}" is not one`,
      );
    }
    return { label: each.slice(0, at).trim(), spec: each.slice(at + 1).trim() };
  });
}

/**
 * Checks the labels of `--subjects`.
 * @param named - The subjects, in order; the first is the baseline.
 * @returns The same subjects.
 * @throws {UsageError} For fewer than 2 or more than 8 subjects, a label that is not lowercase letters, digits and
 *   hyphens starting with a letter, a label that names an option, or a label used twice.
 */
export function requireNamed(named: NamedSubject[]): NamedSubject[] {
  if (named.length < MIN_NAMED || named.length > MAX_NAMED) {
    throw new UsageError(
      `--subjects takes ${String(MIN_NAMED)} to ${String(MAX_NAMED)} subjects, not ${String(named.length)}`,
    );
  }
  const seen = new Set<string>();
  for (const { label } of named) {
    if (!LABEL.test(label)) {
      throw new UsageError(
        `subject label "${label}" must be lowercase letters, digits and hyphens, starting and ending with a letter`,
      );
    }
    if (OPTION_WORDS.includes(label)) {
      throw new UsageError(
        `subject label "${label}" is the name of a subject option; pick another label`,
      );
    }
    if (seen.has(label)) {
      throw new UsageError(
        `duplicate subject label "${label}": labels must be unique`,
      );
    }
    seen.add(label);
  }
  return named;
}

/**
 * Refuses a label that is also the id of a variant of a case in the suite, which would make a result name two things.
 * @param labels - The labels that the user chose.
 * @param cases - The cases of the suite.
 * @throws {UsageError} Naming the label and the case.
 */
function requireNoVariantClash(labels: string[], cases: Case[]): void {
  for (const label of labels) {
    const clash = cases.find((one) => one.variant === label);
    if (clash !== undefined) {
      throw new UsageError(
        `subject label "${label}" is also the id of a variant of the case ${clash.base}; pick another label`,
      );
    }
  }
}

/**
 * Finds the subject that the pass bars apply to.
 * @param labels - The subject labels, in order.
 * @param barSubject - `--bar-subject`; undefined for the last subject.
 * @returns The label.
 * @throws {UsageError} When `--bar-subject` is not one of the labels.
 */
export function barSubjectOf(
  labels: string[],
  barSubject: string | undefined,
): string {
  if (barSubject === undefined) return labels.at(-1) ?? "subject";
  if (!labels.includes(barSubject)) {
    throw new UsageError(
      `--bar-subject ${barSubject} is not a subject label; the labels are ${labels.join(", ")}`,
    );
  }
  return barSubject;
}

/**
 * Refuses a delta bar on the baseline, which has no delta against itself.
 * @param run - The subjects, the bar subject, the delta setup and the cases.
 * @param run.pairs - The subjects in order; the first is the baseline.
 * @param run.barSubject - The label the bars apply to.
 * @param run.delta - The delta setup, whose `minDelta` is the suite's bar; undefined for none.
 * @param run.delta.minDelta - The suite's delta bar.
 * @param run.cases - The cases, each of which may carry a `minDelta`.
 * @throws {UsageError} When the bar subject is the baseline of a comparison and a delta bar is set.
 */
function requireBarOnDelta(run: {
  pairs: { label: string }[];
  barSubject: string;
  delta: { minDelta: number | undefined };
  cases: Case[];
}): void {
  const { pairs, barSubject, delta, cases } = run;
  const barred =
    delta.minDelta !== undefined ||
    cases.some((one) => one.minDelta !== undefined);
  if (pairs.length > 1 && pairs[0]?.label === barSubject && barred) {
    throw new UsageError(
      `--bar-subject ${barSubject} is the baseline, which has no delta against itself: a delta bar (--min-delta, or a case's minDelta) needs another subject`,
    );
  }
}

/**
 * Checks the subjects of a command against its cases and its delta bars.
 * @param run - What the command settled.
 * @param run.names - The labels of `--subjects`; absent for the default labels.
 * @param run.pairs - The subjects in order; the first is the baseline.
 * @param run.barSubject - The label the bars apply to.
 * @param run.delta - The delta setup, whose `minDelta` is the suite's bar; undefined for none.
 * @param run.delta.minDelta - The suite's delta bar.
 * @param run.cases - The cases of the suite.
 * @throws {UsageError} For a label that is a variant id, or a delta bar on the baseline.
 */
export function requireSubjectsFit(run: {
  names: string[] | undefined;
  pairs: { label: string }[];
  barSubject: string;
  delta: { minDelta: number | undefined };
  cases: Case[];
}): void {
  if (run.names !== undefined) requireNoVariantClash(run.names, run.cases);
  requireBarOnDelta(run);
}
