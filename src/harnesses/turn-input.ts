/** The lifecycle events a case can put between turns; each is a capability of the same name. */
export type LifecycleEvent = "compact" | "clear" | "resume";

/** A skill that the user invokes, with the arguments the user gives it. */
export interface Invoke {
  skill: string;
  args?: string | undefined;
}

/** The user turn an adapter is asked to run: what the case says, and what the runner worked out from it. */
export interface TurnInput {
  /** The turn's place in the case's `turns`, from 0. A single prompt is turn 0. */
  index: number;
  /** The user's message; null for an `event` turn. For an `invoke` turn it is the text of the user's syntax. */
  message: string | null;
  /** The skill that the user invokes, for an `invoke` turn. */
  invoke: Invoke | null;
  /** The lifecycle event, for an `event` turn that needs a harness process: only `compact`. */
  event: LifecycleEvent | null;
}

/**
 * Makes the turn fields of the input of a run that has one prompt.
 * @param message - The prompt.
 * @returns Turn 0 with that message, and no session to continue.
 */
export const firstTurn = (
  message: string,
): { turn: TurnInput; session: null } => ({
  turn: { index: 0, message, invoke: null, event: null },
  session: null,
});
