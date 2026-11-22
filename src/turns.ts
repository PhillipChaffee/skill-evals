import type { RunInput } from "./harnesses/shared.js";
import { messageOf } from "./scope.js";
import type { RunEnd } from "./session-end.js";
import { endOf } from "./session-end.js";
import { attempt, notStarted, parseStream } from "./session-attempt.js";
import type { Dirs, SessionInput } from "./session-attempt.js";
import type { Snapshot } from "./snapshot.js";
import { diffSnapshots, snapshot } from "./snapshot.js";
import { lifecyclePart, numbered } from "./transcript.js";
import { emptyParse } from "./turn-merge.js";
import { unasked } from "./turn-reply.js";
import type { Ran, State, Step, TurnsRun } from "./turn-result.js";
import { NO_CHANGES, assemble } from "./turn-result.js";
import type { TurnRecord } from "./turn-outcome.js";
import type { Turn } from "./turn-spec.js";
import { describeTurn } from "./turn-spec.js";

const MS = 1000;

/** Where a turn is: the run's directories, the turn, its place and where the run stands. */
interface Place {
  dirs: Dirs;
  turn: Turn;
  /** The turn's place in the case's list, from 0. */
  index: number;
  state: State;
}

/**
 * Starts the record of a turn.
 * @param turn - Any turn.
 * @param index - The turn's place, from 0.
 * @returns The record of the turn, before it has run.
 */
function recordOf(turn: Turn, index: number): TurnRecord {
  const base = {
    turn: index + 1,
    skipped: null,
    finalText: "",
    loaded: null,
    sessionId: null,
  };
  if ("prompt" in turn) return { ...base, kind: "prompt" };
  if ("invoke" in turn) return { ...base, kind: "invoke" };
  if ("reply" in turn) return { ...base, kind: "reply" };
  return { ...base, kind: "event", event: turn.event };
}

/**
 * Works out what is sent to the harness for a turn.
 * @param turn - The turn to send.
 * @param run - The case's session, whose harness may have a user syntax.
 * @returns The text: the prompt, the user's syntax for an invocation, or null for an event.
 * @throws {Error} For an invocation on a harness with no user syntax, which applicability keeps out.
 */
function sentText(turn: Turn, run: SessionInput): string | null {
  if ("prompt" in turn) return turn.prompt;
  if ("reply" in turn) return turn.reply.prompt;
  if ("event" in turn) return null;
  const text = run.harness.userInvocation?.(turn.invoke);
  if (text === undefined) {
    throw new Error(`${run.harness.id} has no user syntax to invoke a skill`);
  }
  return text;
}

/**
 * Builds what the adapter gets for one turn.
 * @param run - The case's session.
 * @param place - Where the turn is.
 * @returns The input of `invocation`, with the session to continue.
 */
function inputFor(run: SessionInput, place: Place): RunInput {
  const { turn, index, state } = place;
  const message = sentText(turn, run);
  return {
    subject: run.subject,
    home: place.dirs.home,
    workspace: place.dirs.workspace,
    prompt: message ?? "",
    turn: {
      index,
      message,
      invoke: "invoke" in turn ? turn.invoke : null,
      event: "event" in turn && turn.event === "compact" ? "compact" : null,
    },
    session: state.session,
    model: run.model,
    maxTurns: run.maxTurns,
    isolated: run.isolated,
  };
}

/**
 * Runs one turn in a harness process and reads what it wrote.
 * @param run - The case's session, with the time this turn may take.
 * @param input - What the adapter gets.
 * @param state - Where the run stands: what the first process set up, and a failure that keeps the first from starting.
 * @returns The process, and how the turn ended.
 */
async function runProcess(
  run: SessionInput,
  input: RunInput,
  state: State,
): Promise<Ran> {
  const made =
    state.failure === null
      ? await attempt(run, input, state.prior)
      : notStarted(state.failure, input.home);
  state.failure = null;
  const end = endOf({
    ...made,
    parsed: parseStream(run.harness, made.stdout),
    onTimeout: run.onTimeout,
  });
  return { attempt: made, end };
}

/**
 * Makes the step of a turn that is not sent.
 * @param record - The turn's record.
 * @param why - The cause, in words: what stopped the run.
 * @returns The step, with the turn marked as skipped because the run was stopped.
 */
const skippedStep = (record: TurnRecord, why: string): Step => ({
  record: { ...record, skipped: "stopped", why },
  parsed: emptyParse(),
  ran: null,
  changes: NO_CHANGES,
});

/**
 * Makes the step of a conditional reply that is not sent because the agent did not ask.
 * @param record - The turn's record, of kind `reply`.
 * @param why - What the agent did instead, in words.
 * @returns The step, with the turn marked as skipped "not asked". The run goes on: later turns are sent.
 */
const unaskedStep = (record: TurnRecord, why: string): Step => ({
  record: { ...record, skipped: "not asked", why },
  parsed: emptyParse(),
  ran: null,
  changes: NO_CHANGES,
});

/**
 * Carries out a lifecycle event that needs no harness process: the runner drops or keeps the session itself.
 * @param record - The turn's record, of kind `event`.
 * @param state - Where the run stands; a `clear` forgets the session.
 * @returns The step, whose transcript holds one `lifecycle` event.
 */
function runnerEvent(record: TurnRecord, state: State): Step {
  if (record.event === "clear") {
    state.continuing = false;
    state.session = null;
  }
  const events = numbered([lifecyclePart(record.event ?? "resume")]);
  return {
    record,
    parsed: emptyParse(events),
    ran: null,
    changes: NO_CHANGES,
  };
}

/**
 * Tells why a turn cannot be sent yet, when it would continue a session that no earlier turn named.
 * @param state - Where the run stands.
 * @returns The message of the failure; null when the turn may go.
 */
const lackOf = (state: State): string | null =>
  state.continuing && state.session === null
    ? `turn ${String(state.last)} gave no session id to continue`
    : null;

/**
 * Tells how long a process turn may take.
 * @param run - The case's session.
 * @param state - Where the run stands.
 * @returns The seconds this turn may take: `timeoutSeconds`, or exactly what is left of the whole run's time when that
 *   is less; 0 when none is left.
 */
function secondsLeft(run: SessionInput, state: State): number {
  const left = state.cap - state.spent / MS;
  return Math.max(0, Math.min(run.timeoutSeconds, left));
}

/**
 * Notes how a process turn ended, and whether it stops the run.
 * @param ran - The process and how it ended.
 * @param state - Where the run stands; updated with the session and any stop.
 * @param turn - The turn's number, from 1.
 */
function settle(ran: Ran, state: State, turn: number): void {
  const { end } = ran;
  state.spent += ran.attempt.durationMs;
  state.prior ??= ran.attempt.prior;
  state.last = turn;
  state.continuing = true;
  state.session = end.parsed.sessionId;
  if (end.error !== null || end.stoppedBy !== "agent") {
    const how =
      end.stoppedBy === "agent" ? "failed" : `stopped at ${end.stoppedBy}`;
    state.stop = {
      stoppedBy: end.stoppedBy,
      error: end.error,
      why: `turn ${String(turn)} ${how}`,
    };
  }
}

/**
 * Checks that a compaction left its mark.
 * @param end - How the turn ended.
 * @returns A failed end when the stream shows no `compact` lifecycle event: nothing says it happened.
 */
function compacted(end: RunEnd): RunEnd {
  const shown = end.parsed.transcript.some(
    (event) => event.type === "lifecycle" && event.name === "compact",
  );
  return shown || end.error !== null
    ? end
    : { ...end, error: "the harness did not report the compaction" };
}

/**
 * Holds a finished turn to what the runner asked of it.
 * @param end - How the turn ended.
 * @param asked - What the turn was given.
 * @param asked.given - The session id the process was told to continue; null when it started a new session.
 * @param asked.turn - The turn's number, from 1.
 * @param asked.shortened - Whether the whole run's time limit, not `timeoutSeconds`, set the turn's time.
 * @param asked.cap - The whole run's time limit in seconds.
 * @returns The end, failed when the process reported another session than the one it was given, and with the whole
 *   run's limit in the words of a timeout that it caused.
 */
function checked(
  end: RunEnd,
  asked: {
    given: string | null;
    turn: number;
    shortened: boolean;
    cap: number;
  },
): RunEnd {
  const reported = end.parsed.sessionId;
  if (
    end.error === null &&
    asked.given !== null &&
    reported !== null &&
    reported !== asked.given
  ) {
    return {
      ...end,
      error: `turn ${String(asked.turn)} continued session ${asked.given} but reported ${reported}`,
    };
  }
  return end.stoppedBy === "timeout" && asked.shortened && end.error !== null
    ? { ...end, error: `timed out after ${String(asked.cap)} s` }
    : end;
}

/**
 * Finds out whether the run can go on to a turn, and records why not.
 * @param run - The case's session.
 * @param place - Where the turn is.
 * @param record - The turn's record.
 * @returns True when the turn is to be skipped: the run has stopped, or cannot continue its session, or is out of time.
 */
function blocked(run: SessionInput, place: Place, record: TurnRecord): boolean {
  const { state } = place;
  const keepsSession = record.kind === "event" && record.event === "clear";
  const lack = state.stop === null && !keepsSession ? lackOf(state) : null;
  if (lack !== null) {
    state.stop = { stoppedBy: "agent", error: lack, why: lack };
  }
  const processes = !(record.kind === "event" && record.event !== "compact");
  if (state.stop === null && processes && secondsLeft(run, state) === 0) {
    const error =
      run.onTimeout === "score"
        ? null
        : `timed out after ${String(state.cap)} s`;
    state.stop = {
      stoppedBy: "timeout",
      error,
      why: "the run's time limit was reached",
    };
  }
  return state.stop !== null;
}

/**
 * Runs one turn of the case.
 * @param run - The case's session.
 * @param place - Where the turn is.
 * @returns What the turn left.
 */
async function runTurn(run: SessionInput, place: Place): Promise<Step> {
  const { turn, index, state } = place;
  const record = recordOf(turn, index);
  if (blocked(run, place, record)) {
    return skippedStep(record, state.stop?.why ?? "");
  }
  if (record.kind === "event" && record.event !== "compact") {
    return runnerEvent(record, state);
  }
  const why = "reply" in turn ? unasked(turn.reply, state.sent) : null;
  if (why !== null) return unaskedStep(record, why);
  const seconds = secondsLeft(run, state);
  const made = await runProcess(
    { ...run, timeoutSeconds: seconds },
    inputFor(run, place),
    state,
  );
  const ran = {
    ...made,
    end: checked(record.event === "compact" ? compacted(made.end) : made.end, {
      given: state.session,
      turn: record.turn,
      shortened: seconds < run.timeoutSeconds,
      cap: state.cap,
    }),
  };
  settle(ran, state, record.turn);
  const { parsed } = ran.end;
  if (record.kind !== "event") {
    state.sent = { turn: record.turn, parsed };
  }
  return {
    record: {
      ...record,
      finalText: parsed.finalText,
      loaded: parsed.loaded,
      sessionId: parsed.sessionId,
      askedUser: parsed.askedUser ?? null,
    },
    parsed: ran.end.parsed,
    ran,
    changes: NO_CHANGES,
  };
}

/**
 * Takes the workspace changes of a turn, by a hash of the workspace after it.
 * @param step - The turn's step, which gets its `changes`.
 * @param state - Where the run stands; its snapshot moves to the workspace as the turn left it.
 * @param workspace - The run's workspace.
 * @returns The step, with what the turn changed. A turn that ran nothing changed nothing.
 */
function withChanges(step: Step, state: State, workspace: string): Step {
  if (step.ran === null) return step;
  const after = snapshot(workspace);
  const changes = diffSnapshots(state.workspace, after);
  state.workspace = after;
  return { ...step, changes };
}

/**
 * Runs the turns of a case, one harness process each, in one workspace and one home. Each process continues the
 * session of the turn before by the adapter's own means. The run goes on until a turn fails, is stopped at `maxTurns`
 * or by a time limit, or gives no session id for the next to continue; the turns after it are not sent and are
 * recorded as skipped. `timeoutSeconds` applies to each turn, and the whole run has `totalTimeoutSeconds`, or
 * `timeoutSeconds` times the number of turns.
 * @param run - The case's session; `turns` is set.
 * @param start - Where the run is, and how it starts.
 * @param start.dirs - Where the run is.
 * @param start.seed - The workspace before the first turn.
 * @param start.failure - Why the harness cannot start, such as a failed setup step; null when it can.
 * @returns The merged result, and each turn's record and workspace changes.
 * @throws {Error} For an exception while a turn was run, naming the turn.
 */
export async function runTurns(
  run: SessionInput,
  start: { dirs: Dirs; seed: Snapshot; failure: string | null },
): Promise<TurnsRun> {
  const turns = run.turns ?? [];
  const state: State = {
    session: null,
    continuing: false,
    last: 0,
    stop: null,
    prior: null,
    failure: start.failure,
    sent: { turn: 0, parsed: emptyParse() },
    workspace: start.seed,
    cap: run.totalTimeoutSeconds ?? run.timeoutSeconds * turns.length,
    spent: 0,
  };
  const steps: Step[] = [];
  for (const [index, turn] of turns.entries()) {
    try {
      const step = await runTurn(run, { dirs: start.dirs, turn, index, state });
      steps.push(withChanges(step, state, start.dirs.workspace));
    } catch (error) {
      throw new Error(
        `turn ${String(index + 1)} (${describeTurn(turn)}): ${messageOf(error)}`,
        { cause: error },
      );
    }
  }
  return assemble(steps, state);
}
