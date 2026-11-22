import { endsAwaiting, questionsIn } from "./question.js";
import type { Sent } from "./turn-result.js";

/**
 * Decides whether a conditional reply turn is to be sent.
 * @param reply - The turn's condition.
 * @param reply.whenAsked - A regular expression for the question text.
 * @param sent - The previous turn that was sent: its number and what its process wrote.
 * @returns Null when the turn is to be sent: that turn ended awaiting the user (its last main-agent event is a question
 *   call) and one of the questions it ended on matches `whenAsked`; an earlier question that the agent went on after does
 *   not count, and nor does one that a subagent asked. Otherwise
 *   the reason it was not asked, in words.
 */
export function unasked(
  reply: { whenAsked: string },
  sent: Sent,
): string | null {
  const here = `turn ${String(sent.turn)}`;
  const { transcript, askedUser } = sent.parsed;
  if (sent.turn === 0) return "no turn has been sent in this session";
  if (!endsAwaiting(transcript, askedUser)) {
    return `${here} did not end by asking the user`;
  }
  const pattern = new RegExp(reply.whenAsked);
  return questionsIn(transcript).some((question) => pattern.test(question))
    ? null
    : `no question of ${here} matches /${reply.whenAsked}/`;
}
