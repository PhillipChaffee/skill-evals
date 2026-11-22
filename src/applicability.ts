import type { Capability, Need } from "./capabilities.js";
import { findOnPath } from "./capabilities.js";
import type { Case } from "./cases.js";
import { allChecks, dropChecks, turnNeeds } from "./case-checks.js";
import type { Check } from "./checks/index.js";
import { CHECKS, describeCheck } from "./checks/index.js";
import type { Harness } from "./harnesses/shared.js";
import { historyNeeds } from "./history-needs.js";
import type { HistoryMode } from "./history-types.js";
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
 * Lists what a check needs at least one of, such as a source of injected text that a hook or a rule may give.
 * @param check - Any check of a case.
 * @returns The capabilities of which one must be present; none for a check that has no such need.
 */
const eitherNeeds = (check: Check): Capability[] =>
  CHECKS[check.type]?.needsAny?.(check) ?? [];

/**
 * Picks the capabilities of a group that a harness lacks entirely.
 * @param harness - The adapter.
 * @param needs - Capabilities of which at least one must be present.
 * @returns All of them when the harness has none; none when it has one.
 */
const lackingAll = (harness: Harness, needs: Capability[]): Need[] =>
  needs.some((need) => harness.capabilities.has(need)) ? [] : needs;

/**
 * Lists every need of a set of cases.
 * @param cases - Every loaded case.
 * @returns The needs of the cases and of their checks, with repeats.
 */
export const askedBy = (cases: Case[]): Need[] =>
  cases.flatMap((caseDef) => [
    ...caseDef.requires,
    ...turnNeeds(caseDef),
    ...[...allChecks(caseDef), ...(caseDef.preconditions ?? [])].flatMap(
      checkNeeds,
    ),
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
 * Decides whether a harness can run a case, in the default history mode of the adapter.
 * @param harness - The adapter, which declares what it can observe or do.
 * @param caseDef - The case, with what it requires and what its checks imply.
 * @param host - The host capabilities that are present, from `hostCapabilities`. Default: none.
 * @returns What `applicabilityUnder` returns.
 */
export const applicability = (
  harness: Harness,
  caseDef: Case,
  host: Host = new Set(),
): Applicability => applicabilityUnder(harness, caseDef, { host });

/**
 * Decides whether a harness can run a case.
 * @param harness - The adapter, which declares what it can observe or do.
 * @param caseDef - The case, with what it requires and what its checks imply.
 * @param where - What else decides it.
 * @param where.host - The host capabilities that are present, from `hostCapabilities`.
 * @param where.forced - `--history-mode`; undefined to take the adapter's own mode, which is `preamble` unless it says so.
 * @returns Applicable, with the checks to drop on this harness; or not applicable, with what is missing and why.
 *   The case is not applicable when it lists other harnesses, when the case or a check that does not say
 *   `ifUnsupported: "skip"` needs something missing, when its history or sessions need what the harness or the mode
 *   lacks (`history`, `historyNative`, `sessionStore`), or when every check would be skipped.
 */
export function applicabilityUnder(
  harness: Harness,
  caseDef: Case,
  where: { host: Host; forced?: HistoryMode | undefined },
): Applicability {
  const { host, forced } = where;
  if (caseDef.harnesses && !caseDef.harnesses.includes(harness.id)) {
    return {
      applicable: false,
      missing: [],
      reason: caseDef.note ?? "the case names other harnesses",
    };
  }
  const seeded = historyNeeds(caseDef, { harness, forced });
  const missing = new Set<Need>(
    lacking(harness, host, [
      ...caseDef.requires,
      ...turnNeeds(caseDef),
      ...seeded.needs,
    ]),
  );
  for (const need of seeded.blocked) missing.add(need);
  const skipped: number[] = [];
  const skippedMissing = new Set<Need>();
  const checks = allChecks(caseDef);
  checks.forEach((check, index) => {
    const absent = [
      ...lacking(harness, host, checkNeeds(check)),
      ...lackingAll(harness, eitherNeeds(check)),
    ];
    if (absent.length === 0) return;
    if (check.ifUnsupported === "skip") {
      skipped.push(index);
      for (const need of absent) skippedMissing.add(need);
    } else {
      for (const need of absent) missing.add(need);
    }
  });
  // A precondition is never skipped: what it needs, the whole case needs.
  for (const one of caseDef.preconditions ?? []) {
    for (const need of [
      ...lacking(harness, host, checkNeeds(one)),
      ...lackingAll(harness, eitherNeeds(one)),
    ]) {
      missing.add(need);
    }
  }
  if (missing.size === 0 && skipped.length === checks.length) {
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
 * @param where - The host capabilities that are present, and `--history-mode` when it is set.
 * @param where.host - The host capabilities that are present.
 * @param where.forced - The forced history mode; undefined for each adapter's own.
 * @returns What each harness runs, the pairs that are not applicable, and the checks that are skipped.
 */
function partition(
  harnesses: Harness[],
  cases: Case[],
  where: { host: Host; forced?: HistoryMode | undefined },
): Partition {
  const result: Partition = { ran: {}, notApplicable: [], skippedChecks: [] };
  for (const harness of harnesses) {
    const ran: Case[] = [];
    for (const caseDef of cases) {
      const { host } = where;
      const verdict = applicabilityUnder(harness, caseDef, where);
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
        const dropped = allChecks(caseDef).filter((_, index) =>
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
      ran.push(dropChecks(caseDef, verdict.skipped));
    }
    result.ran[harness.id] = ran;
  }
  return result;
}

/**
 * Decides, once for the command, which cases each harness runs.
 * @param harnesses - The harnesses that will run, each with the executable to spawn.
 * @param cases - Every loaded case.
 * @param forced - `--history-mode` or the config's `historyMode`; undefined for each adapter's own mode.
 * @returns What each harness runs and what it does not.
 * @throws {UsageError} When no case applies to any of the harnesses.
 */
export function partitionApplicable(
  harnesses: { harness: Harness }[],
  cases: Case[],
  forced?: HistoryMode,
): Partition {
  const parts = partition(
    harnesses.map((located) => located.harness),
    cases,
    { host: hostCapabilities(cases), forced },
  );
  if (Object.values(parts.ran).every((ran) => ran.length === 0)) {
    throw new UsageError(
      `no case applies to ${Object.keys(parts.ran).join(", ")}`,
    );
  }
  return parts;
}
