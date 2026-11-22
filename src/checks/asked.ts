import { describeBy, fitsBy } from "../agents.js";
import { endsAwaiting, questionText } from "../question.js";
import { minOf } from "./defaults.js";
import { checkBounds } from "./bounds.js";
import { byNeeds, unseenAgent } from "./by-needs.js";
import type { Spec } from "./index.js";
import { PASS, regex } from "./rules.js";

// The checks of what the agent asked the user.
export const ASKED_CHECKS = {
  asked_user: {
    fields: [],
    optional: ["min", "max", "pattern", "by"],
    scores:
      "The number of question calls the agent made, of those whose question fits `pattern`, is from `min` to `max`.",
    note: "It counts calls of the tool kind `question` (`AskUserQuestion` in Claude Code), and nothing else: an answer that ends with a question mark is not asking. The question is the call's `questions[].question` texts joined with newlines, or the call's whole input as JSON for a harness whose question tool has another shape. `pattern` is a regular expression for that text, case-sensitive. `min` defaults to 1, and to 0 when `max` is 0. `by` counts the calls of those agents. Needs a harness with `askUser`.",
    needs: (check) => ["askUser", ...byNeeds(check)],
    validate: checkBounds,
    rule: (check, outcome) => {
      const min = check.min ?? minOf(check);
      const max = check.max ?? Infinity;
      const unseen = min === 0 ? unseenAgent(check, outcome) : undefined;
      if (unseen) return unseen;
      const pattern = check.pattern === undefined ? null : regex(check.pattern);
      const asked = outcome.toolCalls.filter(
        (call) => call.kind === "question" && fitsBy(check.by, call.agent),
      );
      const hits = asked.filter(
        (call) => pattern === null || pattern.test(questionText(call)),
      );
      if (hits.length >= min && hits.length <= max) return PASS;
      const noun = `${String(hits.length)} matching ${hits.length === 1 ? "question" : "questions"}`;
      const bound =
        hits.length < min ? `min ${String(min)}` : `max ${String(max)}`;
      const filter = [
        ...(pattern === null ? [] : [`/${check.pattern ?? ""}/`]),
        ...(check.by === undefined ? [] : [`by ${describeBy(check.by)}`]),
      ].join(" ");
      return {
        score: 0,
        reason: [
          `${noun}, ${bound}${filter === "" ? "" : `, for ${filter}`}`,
          asked.length === 0
            ? "the agent asked no question"
            : `asked: ${asked.map((call) => JSON.stringify(questionText(call))).join(", ")}`,
        ].join("\n"),
      };
    },
  },
  ended_awaiting_user: {
    fields: [],
    scores:
      "The last event of the main agent is a question call: the agent stopped for the user's answer.",
    note: "In a turn's `checks` it looks at that turn's last event; at case level, at the run's. The results of question calls are not counted as events, since a headless process answers a question with a refusal. A question that a subagent asked, or that the agent went on after, does not count, and nor does a final message that ends with a question mark. Needs a harness with `askUser`.",
    needs: () => ["askUser"],
    rule: (_check, outcome) =>
      endsAwaiting(outcome.transcript, outcome.askedUser)
        ? PASS
        : {
            score: 0,
            reason: "the last event of the main agent is not a question call",
          },
  },
} satisfies Record<string, Spec>;
