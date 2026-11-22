import type { TranscriptEvent } from "./harnesses/shared.js";

/**
 * Reads what a question call asks. Claude Code's `AskUserQuestion` takes `{ questions: [{ question, ... }] }`; a call of
 * that shape gives its question texts, one to a line. The adapters of other harnesses have no question tool yet, so for
 * any other input the text is the whole input as JSON.
 * @param call - A call of kind `question`.
 * @param call.input - The call's input, as the harness gave it.
 * @returns The question text that `asked_user` and a reply turn's `whenAsked` match against.
 */
export function questionText(call: { input?: unknown }): string {
  const { questions } = Object(call.input) as { questions?: unknown };
  const texts = Array.isArray(questions)
    ? questions.flatMap((one: unknown) => {
        const { question } = Object(one) as { question?: unknown };
        return typeof question === "string" ? [question] : [];
      })
    : [];
  return texts.length > 0 ? texts.join("\n") : JSON.stringify(call.input);
}

/**
 * Tells whether an event is a question call.
 * @param event - An event of the transcript.
 * @returns True for a `tool_call` of kind `question`.
 */
const isQuestion = (event: TranscriptEvent): boolean =>
  event.type === "tool_call" && event.kind === "question";

/**
 * Tells whether a run, or one turn of it, ended with the agent waiting for the user.
 * @param transcript - The events to look at: the whole run's, or one turn's.
 * @param asked - What the adapter reported (`Parsed.askedUser`); true counts as stopping for input.
 * @returns True when the last main-agent event is a question call, ignoring the results of question calls (a headless
 *   process answers one with a refusal), or when the adapter reported that it stopped for input. A final message that
 *   ends with a question mark is not asking: only a question tool is.
 */
export function endsAwaiting(
  transcript: TranscriptEvent[],
  asked: boolean | null | undefined,
): boolean {
  if (asked === true) return true;
  const main = transcript.filter((event) => event.agent.depth === 0);
  const ids = new Set(
    main.filter(isQuestion).flatMap((event) => event.callId ?? []),
  );
  const last = main
    .filter(
      (event) =>
        !(
          event.type === "tool_result" &&
          event.callId !== undefined &&
          ids.has(event.callId)
        ),
    )
    .at(-1);
  return last !== undefined && isQuestion(last);
}

/**
 * Lists what the main agent asked in a stretch of a run.
 * @param transcript - The events to look at.
 * @returns The text of each question call of the main agent, in order.
 */
export const questionsIn = (transcript: TranscriptEvent[]): string[] =>
  transcript
    .filter((event) => event.agent.depth === 0 && isQuestion(event))
    .map((event) => questionText(event));
