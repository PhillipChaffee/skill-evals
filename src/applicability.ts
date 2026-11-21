import type { Capability, Need } from "./capabilities.js";
import { findOnPath } from "./capabilities.js";
import type { Case } from "./cases.js";
import type { Check } from "./checks/index.js";
import { CHECKS, describeCheck } from "./checks/index.js";
import type { Harness } from "./harnesses/shared.js";
import { UsageError } from "./scope.js";

/** Whether a harness can run a case. Decided before any run, from the adapter's declared capabilities. */
export type Applicability =
  | {
      applicable: true;
      /** The indexes of the checks that this harness drops, because they say `ifUnsupported: "skip"`. */
      skipped: number[];
    }
  | {
      applicable: false;
      /** What the harness and the host lack, in the order the case lists it; empty when the case names its harnesses. */
      missing: Need[];
      reason: string;
    };

/** The host capabilities that are present, as `bin:<name>`. */
export type Host = ReadonlySet<string>;

const BIN_PREFIX = "bin:";

/**
 * Lists what a check needs: what its type implies and what the check itself lists.
 * @param check - Any check of a case.
 * @returns The needs, without repeats.
 */
function checkNeeds(check: Check): Need[] {
  const implied = CHECKS[check.type]?.needs?.(check) ?? [];
  return [...new Set<Need>([...implied, ...(check.requires ?? [])])];
}

/**
 * Lists every need of a set of cases.
 * @param cases - Every loaded case.
 * @returns The needs of the cases and of their checks, with repeats.
 */
const askedBy = (cases: Case[]): Need[] =>
  cases.flatMap((caseDef) => [
    ...caseDef.requires,
    ...caseDef.checks.flatMap(checkNeeds),
  ]);

/**
 * Finds the executables that cases ask for, and which of them are on this machine.
 * @param cases - Every loaded case.
 * @param env - Where `PATH` is read from. Default: the process's.
 * @returns The `bin:<name>` needs of the cases whose executable is on `PATH`. A command computes it once.
 */
export function hostCapabilities(
  cases: Case[],
  env: Record<string, string | undefined> = process.env,
): Host {
  return new Set(
    askedBy(cases).filter(
      (need) =>
        need.startsWith(BIN_PREFIX) &&
        findOnPath(need.slice(BIN_PREFIX.length), env) !== null,
    ),
  );
}

/**
 * Names the `bin:` needs of a set of cases, which `check` prints the host's answer for.
 * @param cases - Every loaded case.
 * @returns The distinct `bin:<name>` needs, sorted.
 */
export const binNeeds = (cases: Case[]): string[] =>
  [
    ...new Set(askedBy(cases).filter((need) => need.startsWith(BIN_PREFIX))),
  ].sort();

/**
 * Picks the needs that a harness and the host cannot meet.
 * @param harness - The adapter.
 * @param host - The host capabilities that are present.
 * @param needs - What a case or a check needs.
 * @returns The needs that are missing, in the order given.
 */
const lacking = (harness: Harness, host: Host, needs: Need[]): Need[] =>
  needs.filter((need) =>
    need.startsWith(BIN_PREFIX)
      ? !host.has(need)
      : !harness.capabilities.has(need as Capability),
  );

/**
 * Decides whether a harness can run a case.
 * @param harness - The adapter, which declares what it can observe or do.
 * @param caseDef - The case, with what it requires and what its checks imply.
 * @param host - The host capabilities that are present, from `hostCapabilities`. Default: none.
 * @returns Applicable, with the checks to drop on this harness; or not applicable, with what is missing and why.
 *   The case is not applicable when it lists other harnesses, when the case or a check that does not say
 *   `ifUnsupported: "skip"` needs something missing, or when every check would be skipped.
 */
export function applicability(
  harness: Harness,
  caseDef: Case,
  host: Host = new Set(),
): Applicability {
  if (caseDef.harnesses && !caseDef.harnesses.includes(harness.id)) {
    return {
      applicable: false,
      missing: [],
      reason: caseDef.note ?? "the case names other harnesses",
    };
  }
  const missing = new Set<Need>(lacking(harness, host, caseDef.requires));
  const skipped: number[] = [];
  const skippedMissing = new Set<Need>();
  caseDef.checks.forEach((check, index) => {
    const absent = lacking(harness, host, checkNeeds(check));
    if (absent.length === 0) return;
    if (check.ifUnsupported === "skip") {
      skipped.push(index);
      for (const need of absent) skippedMissing.add(need);
    } else {
      for (const need of absent) missing.add(need);
    }
  });
  if (missing.size === 0 && skipped.length === caseDef.checks.length) {
    for (const need of skippedMissing) missing.add(need);
  }
  if (missing.size > 0) {
    const list = [...missing];
    return {
      applicable: false,
      missing: list,
      reason: `needs ${list.join(", ")}`,
    };
  }
  return { applicable: true, skipped };
}

/** What one case came to on each harness, and the cases as each harness runs them. */
export interface Partition {
  /** For each harness id, the cases it runs; a case with checks skipped has only the checks that stay. */
  ran: Record<string, Case[]>;
  notApplicable: {
    harness: string;
    caseId: string;
    missing: string[];
    reason: string;
  }[];
  skippedChecks: {
    harness: string;
    caseId: string;
    checks: string[];
    missing: string[];
  }[];
}

/**
 * Applies `applicability` to every pair of harness and case.
 * @param harnesses - The harnesses that will run.
 * @param cases - Every loaded case.
 * @param host - The host capabilities that are present.
 * @returns What each harness runs, the pairs that are not applicable, and the checks that are skipped.
 */
function partition(harnesses: Harness[], cases: Case[], host: Host): Partition {
  const result: Partition = { ran: {}, notApplicable: [], skippedChecks: [] };
  for (const harness of harnesses) {
    const ran: Case[] = [];
    for (const caseDef of cases) {
      const verdict = applicability(harness, caseDef, host);
      if (!verdict.applicable) {
        const { missing, reason } = verdict;
        result.notApplicable.push({
          harness: harness.id,
          caseId: caseDef.id,
          missing,
          reason,
        });
        continue;
      }
      if (verdict.skipped.length > 0) {
        const dropped = caseDef.checks.filter((_, index) =>
          verdict.skipped.includes(index),
        );
        result.skippedChecks.push({
          harness: harness.id,
          caseId: caseDef.id,
          checks: dropped.map(describeCheck),
          missing: [
            ...new Set(
              dropped.flatMap((check) =>
                lacking(harness, host, checkNeeds(check)),
              ),
            ),
          ],
        });
      }
      ran.push({
        ...caseDef,
        checks: caseDef.checks.filter(
          (_, index) => !verdict.skipped.includes(index),
        ),
      });
    }
    result.ran[harness.id] = ran;
  }
  return result;
}

/**
 * Decides, once for the command, which cases each harness runs.
 * @param harnesses - The harnesses that will run, each with the executable to spawn.
 * @param cases - Every loaded case.
 * @returns What each harness runs and what it does not.
 * @throws {UsageError} When no case applies to any of the harnesses.
 */
export function partitionApplicable(
  harnesses: { harness: Harness }[],
  cases: Case[],
): Partition {
  const parts = partition(
    harnesses.map((located) => located.harness),
    cases,
    hostCapabilities(cases),
  );
  if (Object.values(parts.ran).every((ran) => ran.length === 0)) {
    throw new UsageError(
      `no case applies to ${Object.keys(parts.ran).join(", ")}`,
    );
  }
  return parts;
}
