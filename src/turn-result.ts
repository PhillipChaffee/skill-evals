import type { Parsed } from "./harnesses/shared.js";
import type { Ending } from "./retry.js";
import type { RunEnd } from "./session-end.js";
import type { Attempt, Prior } from "./session-attempt.js";
import type { ChangedFiles, Snapshot } from "./snapshot.js";
import { mergeTurns } from "./turn-merge.js";
import type { TurnRecord } from "./turn-outcome.js";

export const NO_CHANGES: ChangedFiles = {
  created: [],
  modified: [],
  deleted: [],
};

/** A harness process that ran for a turn, and how the turn ended. */
export interface Ran {
  attempt: Attempt;
  end: RunEnd;
}

/** What one turn left. */
export interface Step {
  record: TurnRecord;
  /** The turn's own parse; empty for a turn that sent nothing. */
  parsed: Parsed;
  /** The harness process of the turn; null when no process ran. */
  ran: Ran | null;
  changes: ChangedFiles;
}

/** What `runTurns` gives back, in the shape of one attempt, plus what is per turn. */
export interface TurnsRun {
  /** The streams of every turn, one after the other. */
  stdout: string;
  durationMs: number;
  /** The main-thread turns the runner counted, summed over the processes; null when the harness cannot count them. */
  turns: number | null;
  firstOutputMs: number | null;
  placedChanges: ChangedFiles | null;
  placed: Record<string, string> | undefined;
  homeSeed: Snapshot;
  /** Who ended the run, why it failed, and the parse of all turns. */
  end: RunEnd;
  /** How the run ended, as the process that ended it shows; that process decides whether a retry makes sense. */
  ending: Ending;
  userTurns: TurnRecord[];
  turnChanges: ChangedFiles[];
}

/** The last turn that was sent to the agent: its number, from 1, and what its process wrote. */
export interface Sent {
  turn: number;
  parsed: Parsed;
}

/** Where a run stands between turns. */
export interface State {
  /** The id to continue, when a turn has given one. */
  session: string | null;
  /** True once a process turn has run, until a `clear`: the next process turn continues a session. */
  continuing: boolean;
  /** The number of the last turn that ran a process. */
  last: number;
  /** Why the later turns are not sent; null while the run goes on. */
  stop: {
    stoppedBy: RunEnd["stoppedBy"];
    error: string | null;
    /** What a check of a turn that was not sent says: the cause, such as `turn 1 stopped at maxTurns`. */
    why: string;
  } | null;
  /** The harness's setup, from the first process. */
  prior: Prior | null;
  /** Why the first process cannot start, such as a failed setup step of the case; null otherwise. */
  failure: string | null;
  /** The last prompt, invocation or reply that was sent; a conditional reply asks whether it ended awaiting the user. */
  sent: Sent;
  /** The workspace after the last turn. */
  workspace: Snapshot;
  /** The seconds all turns may take together. */
  cap: number;
  /** The milliseconds the processes have taken. */
  spent: number;
}

/**
 * Joins the streams of the processes of a run.
 * @param attempts - The processes, in order.
 * @returns The streams one after the other, each ending its last line.
 */
const streamsOf = (attempts: Attempt[]): string =>
  attempts
    .map((one) =>
      one.stdout === "" || one.stdout.endsWith("\n")
        ? one.stdout
        : `${one.stdout}\n`,
    )
    .join("");

/**
 * Names the turn that failed in the error of the run.
 * @param error - The turn's error.
 * @param turn - The turn's number, from 1.
 * @returns The error with `turn N: ` before it, unless it already names its turn.
 */
const prefixed = (error: string, turn: number): string =>
  error.startsWith(`turn ${String(turn)} `)
    ? error
    : `turn ${String(turn)}: ${error}`;

/**
 * Puts the steps of the turns into the result of one run.
 * @param steps - What each turn left.
 * @param state - Where the run stands; its stop is the error of a run that was not sent on.
 * @returns The run's streams, usage, end and per-turn records.
 */
export function assemble(steps: Step[], state: State): TurnsRun {
  const processes = steps.flatMap((step) => (step.ran ? [step.ran] : []));
  const attempts = processes.map((one) => one.attempt);
  const failing = steps.find(
    (step) =>
      step.ran !== null &&
      (step.ran.end.error !== null || step.ran.end.stoppedBy !== "agent"),
  );
  const decisive = failing ?? steps.filter((step) => step.ran !== null).at(-1);
  const first = attempts[0];
  const parsed = mergeTurns(
    steps.map((step) => step.parsed),
    steps.map((step) => step.ran !== null),
  );
  // What the user hears last is the last message or invocation, never a trailing compaction.
  const speaker = steps
    .filter((step) => step.ran !== null && step.record.kind !== "event")
    .at(-1);
  const own = failing?.ran?.end.error ?? null;
  const error =
    own === null
      ? (state.stop?.error ?? null)
      : prefixed(own, failing?.record.turn ?? 0);
  const stoppedBy =
    failing?.ran?.end.stoppedBy ?? state.stop?.stoppedBy ?? "agent";
  const counted = attempts.flatMap((one) => one.turns ?? []);
  return {
    stdout: streamsOf(attempts),
    durationMs: attempts.reduce((total, one) => total + one.durationMs, 0),
    turns: counted.length === 0 ? null : counted.reduce((a, b) => a + b, 0),
    firstOutputMs: first?.firstOutputMs ?? null,
    placedChanges: state.prior?.changes() ?? first?.placedChanges ?? null,
    placed: state.prior?.placed ?? first?.placed,
    homeSeed:
      state.prior?.homeSeed ?? first?.homeSeed ?? new Map<string, string>(),
    end: {
      stoppedBy,
      error,
      parsed: { ...parsed, error, finalText: speaker?.parsed.finalText ?? "" },
    },
    ending: {
      error,
      stoppedBy,
      agentEvents: decisive?.parsed.transcript.length ?? 0,
      unfinished: decisive?.parsed.unfinished === true,
      fault: decisive?.ran?.attempt.fault ?? null,
      exec: decisive?.ran?.attempt.exec ?? {
        kind: null,
        exit: null,
        signal: null,
      },
    },
    userTurns: steps.map((step) => step.record),
    turnChanges: steps.map((step) => step.changes),
  };
}
