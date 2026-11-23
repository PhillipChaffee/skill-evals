import type {
  Harness,
  Parsed,
  ToolCall,
  TranscriptEvent,
} from "./harnesses/shared.js";

/**
 * Reads what a question call asks.
 * @param call - A call of kind `question`.
 * @param call.input - The call's input, as the harness gave it.
 * @param call.question - What its adapter read the call to ask, when it read anything.
 * @returns The question text that `asked_user` and a reply turn's `whenAsked` match against: what the adapter's
 *   `questionText` read, else the whole input as JSON.
 */
export const questionText = (call: {
  input?: unknown;
  question?: string;
}): string => call.question ?? JSON.stringify(call.input);

/**
 * Gives each question call of a parsed stream the text its adapter reads from it.
 * @param harness - The adapter, whose `questionText` knows the shape of its question tool's input.
 * @param parsed - What the adapter read.
 * @returns `parsed` itself for an adapter with no `questionText`; else the transcript and the calls with `question` set
 *   on each question call whose input the adapter could read.
 */
export function withQuestions(
  harness: Pick<Harness, "questionText">,
  parsed: Parsed,
): Parsed {
  const read = harness.questionText;
  if (read === undefined) return parsed;
  const asked = <T extends { kind?: string; input?: unknown }>(one: T): T => {
    const question = one.kind === "question" ? read(one.input) : null;
    return question === null ? one : { ...one, question };
  };
  return {
    ...parsed,
    transcript: parsed.transcript.map((one) =>
      one.type === "tool_call" ? asked(one) : one,
    ),
    toolCalls: parsed.toolCalls.map((one: ToolCall) => asked(one)),
  };
}

/**
 * Tells whether an event is a question call.
 * @param event - An event of the transcript.
 * @returns True for a `tool_call` of kind `question`.
 */
const isQuestion = (event: TranscriptEvent): boolean =>
  event.type === "tool_call" && event.kind === "question";

/**
 * Lists the main agent's events of a stretch of a run, leaving out the results of question calls: a headless process
 * answers a question with a refusal, which is not the agent doing anything.
 * @param transcript - The events to look at.
 * @returns The main agent's events in order, with no result of a question call.
 */
function mainEvents(transcript: TranscriptEvent[]): TranscriptEvent[] {
  const main = transcript.filter((event) => event.agent.depth === 0);
  const ids = new Set(
    main.filter(isQuestion).flatMap((event) => event.callId ?? []),
  );
  return main.filter(
    (event) =>
      !(
        event.type === "tool_result" &&
        event.callId !== undefined &&
        ids.has(event.callId)
      ),
  );
}

/**
 * Finds the question calls that the run ended on: the main agent's last events, if they are question calls (several
 * when it asked in parallel).
 * @param transcript - The events to look at: the whole run's, or one turn's.
 * @returns The trailing question calls, in order; none when the last main-agent event is anything else. A question
 *   asked earlier, with more work after it, is not among them.
 */
export function awaitedCalls(transcript: TranscriptEvent[]): TranscriptEvent[] {
  const events = mainEvents(transcript);
  return events.slice(events.map(isQuestion).lastIndexOf(false) + 1);
}

/**
 * Tells whether a run, or one turn of it, ended with the agent waiting for the user.
 * @param transcript - The events to look at: the whole run's, or one turn's.
 * @param asked - What the adapter reported (`Parsed.askedUser`). An adapter sets it only when its harness refused the
 *   very question call that the run ended on, so it never says more than the last-event rule.
 * @returns True when the last main-agent event is a question call, ignoring the results of question calls. A final
 *   message that ends with a question mark is not asking: only a question tool is. A question that a subagent asked, or
 *   that the agent went on after, does not count.
 */
export function endsAwaiting(
  transcript: TranscriptEvent[],
  asked: boolean | null | undefined,
): boolean {
  return asked === true || awaitedCalls(transcript).length > 0;
}

/**
 * Lists what the main agent asked when the stretch ended on a question.
 * @param transcript - The events to look at.
 * @returns The text of each question call that the stretch ended on, in order; none when it did not end on one.
 */
export const questionsIn = (transcript: TranscriptEvent[]): string[] =>
  awaitedCalls(transcript).map((event) => questionText(event));

/** The check types that read the question kind, which a record made before it cannot answer. */
export const QUESTION_CHECKS = new Set(["asked_user", "ended_awaiting_user"]);
