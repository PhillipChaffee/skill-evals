import type { Partition } from "./applicability.js";
import type { Comparison, SubjectComparison } from "./comparison.js";
import { compare, externalNone } from "./comparison.js";
import type { DeltaSetup } from "./evaluate-setup.js";
import type { RunRecord } from "./run.js";
import type { SubjectSummary } from "./subject.js";

/** What a comparison is made from. */
interface Compared {
  subjects: SubjectSummary[];
  parts: Partition;
  records: RunRecord[];
  delta: DeltaSetup;
}

/**
 * Compares every subject after the first with the first, which is the baseline.
 * @param finished - The subjects, the cases each harness ran, the runs, and the settings of the comparison.
 * @param harnesses - The ids of the harnesses, in report order.
 * @returns One comparison for each subject but the first, in order; none for one subject. The discrimination of each is
 *   taken against the first subject whose kind is "none", when there is one.
 */
export function comparisonsOf(
  finished: Compared,
  harnesses: string[],
): SubjectComparison[] {
  const [first, ...rest] = finished.subjects;
  return first === undefined
    ? []
    : rest.map((subject) => ({
        subject: subject.label,
        baseline: first.label,
        ...compare({
          harnesses,
          applied: finished.parts.ran,
          records: finished.records,
          kinds: { a: first.kind, b: subject.kind },
          labels: { a: first.label, b: subject.label },
          noneLabel: externalNone(finished.subjects, {
            a: first.label,
            b: subject.label,
          }),
          seed: finished.delta.seed,
          noise: finished.delta.noise?.noise ?? null,
        }),
      }));
}

/**
 * Takes the part of `results.json` that a comparison adds.
 * @param delta - The delta bar, the seed and the noise file.
 * @param comparisons - What `comparisonsOf` returned.
 * @param barSubject - The label the bars apply to.
 * @returns The bar, the seed, the noise file's path, the comparison of the bar subject with the baseline (null when
 *   the bar subject is the baseline or there is one subject) and every comparison.
 */
export const deltaFields = (
  delta: DeltaSetup,
  comparisons: SubjectComparison[],
  barSubject: string,
) => ({
  minDelta: delta.minDelta ?? null,
  seed: delta.seed,
  noiseFile: delta.noise?.file ?? null,
  noiseMeta: delta.noise
    ? {
        harness: delta.noise.noise.harness,
        reps: delta.noise.noise.reps,
        caseIds: delta.noise.noise.caseIds,
      }
    : null,
  minDeltaIgnored: delta.ignored,
  comparison: barComparison(comparisons, barSubject),
  barSubject,
  comparisons,
});

/**
 * Takes the comparison that the delta bars apply to.
 * @param comparisons - What `comparisonsOf` returned.
 * @param barSubject - The label the bars apply to.
 * @returns The comparison of B against A for two subjects, whatever the bar subject. For more, the bar subject's
 *   comparison with the baseline; null when that is the baseline. The labels are left out, as `results.json` has always
 *   held it. Null for one subject.
 */
function barComparison(
  comparisons: SubjectComparison[],
  barSubject: string,
): Comparison | null {
  // Two subjects have one comparison, B against A, whatever the bar subject is.
  const found =
    comparisons.length === 1
      ? comparisons[0]
      : comparisons.find((one) => one.subject === barSubject);
  return found === undefined ? null : { harnesses: found.harnesses };
}
