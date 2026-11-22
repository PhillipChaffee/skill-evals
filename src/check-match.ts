import type { Check } from "./checks/index.js";
import { describeCheck } from "./checks/index.js";

/**
 * Pairs the checks of one list with those of another. Checks match by description, which starts with the type; checks
 * that share a description pair by position: the first with the first, the second with the second.
 * @param from - The checks of one side, such as an earlier run's.
 * @param to - The checks of the other side.
 * @returns For each check of `to`, the index of its match in `from`; null when `from` has none.
 */
export function matchChecks(from: Check[], to: Check[]): (number | null)[] {
  const slots = new Map<string, number[]>();
  for (const [index, check] of from.entries()) {
    const key = describeCheck(check);
    slots.set(key, [...(slots.get(key) ?? []), index]);
  }
  const used = new Map<string, number>();
  return to.map((check) => {
    const key = describeCheck(check);
    const nth = used.get(key) ?? 0;
    used.set(key, nth + 1);
    return slots.get(key)?.[nth] ?? null;
  });
}
