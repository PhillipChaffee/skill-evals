import type { Case } from "./cases.js";

/** One run of a plan, before it is made. */
export interface Slot<Harness, Subject> {
  located: Harness;
  caseDef: Case;
  rep: number;
  subject: Subject;
}

/**
 * Lists the runs of a plan in plan order: for each harness, each case, each rep, each subject.
 * @param plan - The harnesses, the cases each runs by harness id, the default reps, and the subjects or whatever stands
 *   for them.
 * @param plan.chosen - The harnesses, each with its adapter.
 * @param plan.applied - For each harness id, the cases it runs.
 * @param plan.reps - The reps for each subject and case; a case's own `reps` wins.
 * @param plan.subjects - What each run is made for: subjects, or labels that stand for them.
 * @returns Every run.
 */
export const slotsOf = <
  Harness extends { harness: { id: string } },
  Subject,
>(plan: {
  chosen: Harness[];
  applied: Record<string, Case[]>;
  reps: number;
  subjects: Subject[];
}): Slot<Harness, Subject>[] =>
  plan.chosen.flatMap((located) =>
    (plan.applied[located.harness.id] ?? []).flatMap((caseDef) =>
      Array.from({ length: caseDef.reps ?? plan.reps }, (_, index) =>
        plan.subjects.map((subject) => ({
          located,
          caseDef,
          rep: index + 1,
          subject,
        })),
      ).flat(),
    ),
  );
