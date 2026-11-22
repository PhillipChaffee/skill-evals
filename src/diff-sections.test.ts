import { expect, test } from "vitest";
import { diffResults } from "./diff.js";
import { renderDiff } from "./diff-render.js";
import type { Results } from "./evaluate.js";
import type { RunRecord } from "./run.js";
import { record, result, results } from "./testing/diff.js";

test("a diff covers every subject label both have, and warns about a label that only one has", () => {
  const both = (labels: string[]) =>
    results(
      labels.map((label) => record([1], { subject: label })),
      {
        subjects: labels.map((label) => ({ label })),
        suites: [
          {
            harness: "h",
            suite: Object.fromEntries(labels.map((label) => [label, 1])),
            cases: [
              {
                id: "c",
                weight: 1,
                scores: Object.fromEntries(labels.map((label) => [label, 1])),
                runs: Object.fromEntries(
                  labels.map((label) => [label, { valid: 1, planned: 1 }]),
                ),
              },
            ],
          },
        ],
      } as unknown as Partial<Results>,
    );
  const found = diffResults(both(["a", "b"]), both(["b", "c"]));
  expect(found.sections.map((one) => one.labels)).toEqual([{ a: "b", b: "b" }]);
  expect(found.warnings).toContain("the subject label a is only in A");
  expect(found.warnings).toContain("the subject label c is only in B");
  const split = diffResults(both(["a", "b"]), both(["a", "b"]));
  expect(split.sections).toHaveLength(2);
  expect(renderDiff(split, { a: "x", b: "y" })).toContain("## Subject b / b");
  const none = diffResults(both(["a"]), both(["c"]));
  expect(none.sections[0]?.labels).toEqual({ a: "a", b: "c" });
  expect(none.warnings.join("\n")).toContain("no subject label in common");
});

test("a check is followed by its identity when a run lists its checks in another order", () => {
  const other = { ...result(1), text: "y" };
  const first = record([1]);
  first.checks = [result(1), other] as unknown as RunRecord["checks"];
  const swapped = record([1]);
  swapped.rep = 2;
  swapped.checks = [other, { ...result(0) }] as unknown as RunRecord["checks"];
  const a = results([first, swapped]);
  const b = results([record([0])]);
  const [one] = diffResults(a, b).sections[0]?.cases ?? [];
  expect(one?.newlyFailing).toHaveLength(1);
  expect(one?.newlyFailing[0]).toMatchObject({ from: 0.5, to: 0 });
});

test("a check that only B has is not listed as a change", () => {
  const added = { ...result(0), text: "added" };
  const b = record([1]);
  b.checks = [result(1), added] as unknown as RunRecord["checks"];
  const [one] =
    diffResults(results([record([1])]), results([b])).sections[0]?.cases ?? [];
  expect(one?.newlyFailing).toEqual([]);
  expect(one?.newlyPassing).toEqual([]);
});
