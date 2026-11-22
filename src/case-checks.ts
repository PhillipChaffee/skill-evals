import type { Need } from "./capabilities.js";
import type { Case } from "./cases.js";
import type { Check } from "./checks/index.js";
import { LIFECYCLE_EVENTS } from "./turn-spec.js";

/** The parts of a case that hold checks. */
type Checked = Pick<Case, "checks" | "turns">;

/**
 * Lists every check of a case in one list: the case's own checks, then those of each turn in turn order. A check of a
 * turn carries its `turn`. A run record keeps its check results in this order.
 * @param caseDef - The case whose checks are listed.
 * @returns The checks, with the case's own first.
 */
export const allChecks = (caseDef: Checked): Check[] => [
  ...caseDef.checks,
  ...(caseDef.turns ?? []).flatMap((turn) => turn.checks),
];

/**
 * Makes the case that scoring reads: every check, per-turn ones included, in `checks`.
 * @param caseDef - The case to be scored.
 * @returns The case with the flat list. Its `turns` stay, for what reads the prompt, and are not read for checks again.
 */
export const flattened = <T extends Checked>(caseDef: T): T => ({
  ...caseDef,
  checks: allChecks(caseDef),
});

/**
 * Takes checks out of a case by their place in `allChecks`.
 * @param caseDef - The case that is to lose checks.
 * @param drop - The places of the checks to leave out.
 * @returns The case without them, in the same order.
 */
export function dropChecks(caseDef: Case, drop: number[]): Case {
  let place = 0;
  const keep = (list: Check[]): Check[] =>
    list.filter(() => !drop.includes(place++));
  const checks = keep(caseDef.checks);
  return {
    ...caseDef,
    checks,
    turns:
      caseDef.turns?.map((turn) => ({ ...turn, checks: keep(turn.checks) })) ??
      null,
  };
}

/**
 * Lists what a case needs because of its turns: a second turn needs `multiTurn`, an `invoke` needs `userInvoke`, a
 * `reply` needs `askUser` (it is a second turn, so `multiTurn` too), and an event needs the capability of its name.
 * @param caseDef - The case whose turns are read.
 * @returns The needs, without repeats; none for a single prompt.
 */
export function turnNeeds(caseDef: Pick<Case, "turns">): Need[] {
  const turns = caseDef.turns ?? [];
  return [
    ...(turns.length > 1 ? (["multiTurn"] as const) : []),
    ...(turns.some((turn) => "invoke" in turn)
      ? (["userInvoke"] as const)
      : []),
    ...(turns.some((turn) => "reply" in turn) ? (["askUser"] as const) : []),
    ...LIFECYCLE_EVENTS.filter((event) =>
      turns.some((turn) => "event" in turn && turn.event === event),
    ),
  ];
}
