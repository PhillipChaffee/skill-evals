import type { Results } from "./evaluate.js";
import type { RunMeta } from "./meta.js";

/**
 * Finds the cases whose hash differs between two sides.
 * @param a - The earlier side's hashes, by harness id and case id.
 * @param b - The later side's.
 * @returns `<harness> <case>` for each pair whose hash differs or is on one side only.
 */
function changedHashes(
  a: Record<string, Record<string, string>>,
  b: Record<string, Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(
    (harness) => {
      const ids = new Set([
        ...Object.keys(a[harness] ?? {}),
        ...Object.keys(b[harness] ?? {}),
      ]);
      return [...ids]
        .filter((id) => a[harness]?.[id] !== b[harness]?.[id])
        .map((id) => `${harness} ${id}`);
    },
  );
}

/**
 * Says what differs between the settings of two results.
 * @param a - The earlier results.
 * @param b - The later results.
 * @returns One line for each difference; a line for each side that has no meta, which says nothing else about it. The
 *   harness sets are compared sorted.
 */
export function warningsOf(a: Results, b: Results): string[] {
  const warnings: string[] = [];
  // Results written before `meta` existed lack it.
  const metaA = a.meta as RunMeta | undefined;
  const metaB = b.meta as RunMeta | undefined;
  for (const [name, meta] of [
    ["A", metaA],
    ["B", metaB],
  ] as const) {
    if (meta === undefined) {
      warnings.push(
        `${name} has no meta, so its models, versions and case hashes cannot be compared`,
      );
    }
  }
  const setA = [...a.harnesses].sort();
  const setB = [...b.harnesses].sort();
  if (setA.join(",") !== setB.join(",")) {
    warnings.push(
      `the harnesses differ: A ${setA.join(", ")}; B ${setB.join(", ")}`,
    );
  }
  if (metaA === undefined || metaB === undefined) return warnings;
  for (const kind of ["agent", "judge", "decision"] as const) {
    if (metaA.models[kind] !== metaB.models[kind]) {
      warnings.push(
        `the ${kind} model differs: A ${metaA.models[kind] ?? "unset"}; B ${metaB.models[kind] ?? "unset"}`,
      );
    }
  }
  if (metaA.toolVersion !== metaB.toolVersion) {
    warnings.push(
      `the tool version differs: A ${metaA.toolVersion}; B ${metaB.toolVersion}`,
    );
  }
  const changed = changedHashes(metaA.caseHashes, metaB.caseHashes);
  if (changed.length > 0) {
    warnings.push(
      `the case changed (its hash differs) in: ${changed.join(", ")}`,
    );
  }
  return warnings;
}

/**
 * Pairs the subject labels of two results.
 * @param a - The earlier results.
 * @param b - The later results.
 * @returns The labels both have, each compared with itself, and a warning for each label that only one has. When they
 *   share none, the last subject of each, which is the one under test, with a warning.
 */
export function labelPairs(
  a: Results,
  b: Results,
): { pairs: { a: string; b: string }[]; warnings: string[] } {
  const labelsA = a.subjects.map((one) => one.label);
  const labelsB = b.subjects.map((one) => one.label);
  const common = labelsA.filter((label) => labelsB.includes(label));
  if (common.length === 0) {
    const lastA = labelsA.at(-1) ?? "subject";
    const lastB = labelsB.at(-1) ?? "subject";
    return {
      pairs: [{ a: lastA, b: lastB }],
      warnings: [
        `the two have no subject label in common, so A's ${lastA} is compared with B's ${lastB}`,
      ],
    };
  }
  const only = (name: string, mine: string[], theirs: string[]): string[] => {
    const alone = mine.filter((label) => !theirs.includes(label));
    return alone.length === 0
      ? []
      : [`the subject label ${alone.join(", ")} is only in ${name}`];
  };
  return {
    pairs: common.map((label) => ({ a: label, b: label })),
    warnings: [...only("A", labelsA, labelsB), ...only("B", labelsB, labelsA)],
  };
}
