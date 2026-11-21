# Multi-turn cases and history

## Decision

### Turns

A case may list `turns`. Each turn is one of:

- `{ "prompt": "<file>" }`: a user message.
- `{ "invoke": { "skill", "args" } }`: a user invocation of a skill, mapped by the adapter to the harness's own syntax.
- `{ "event": "compact" | "clear" | "resume" }`: a lifecycle event.
- `{ "reply": { "whenAsked": "<regex>", "prompt": "<file>" } }`: sent only when the previous turn ended awaiting the user and the question matches. Otherwise the turn is skipped and recorded as such.

`prompt.md` alone is one turn. `prompt.md` together with `turns` is a load error.

Each turn is one harness process. The adapter continues the session by its own means and declares `multiTurn` only when it can.

Case-level checks see the whole session. A turn's own checks see that turn's slice of the transcript. File checks on a turn use that turn's changed paths, from a hash snapshot taken after each turn. No files are copied for this.

Tokens and cost are summed across turns. `timeoutSeconds` applies to each turn. The overall cap is `timeoutSeconds` times the number of turns, unless `totalTimeoutSeconds` is set.

### Turn limit

The runner counts assistant turns in the stream as it arrives and stops the process group at `maxTurns`. The harness's native flag is also passed where one exists. Hitting the limit scores the run, with `stoppedBy: "maxTurns"`. A harness without turn grouping records `maxTurnsEnforced: false`, and the report says so. The case still runs, as it does in 0.0.1.

### History

`history.json` is an ordered list of `{ role, text, toolCalls? }`. There are two modes:

- `native`: the adapter writes a session into the harness's own store and resumes it. The seeded session is the active session on disk, with assistant turns and tool results intact.
- `preamble`: the history is rendered as a clearly delimited quoted block in front of turn 1.

Each adapter declares its mode. `history` is the capability for either mode. `historyNative` is its own capability, so a case can require it. The record keeps `historyMode`. `--history-mode preamble` forces the common mode for a cross-harness comparison.

History events are in the transcript with `userTurn: -1`. They are excluded from every check.

### Session store

`sessions/sessions.json` plants other past sessions in the harness's prior-session store. This is separate from history. A harness with no such store lacks `sessionStore`, and the case is not applicable there.

## Why

Nine of the consumer's skills work on earlier conversation, and pressure cases need a follow-up push. One prompt and one turn cannot express either.

One process for each turn works with every CLI that can continue a session, and it keeps the stream of each turn separate, which makes per-turn slices exact.

Some skills are wrong under a preamble. A skill that restates its own previous message, or that finds the active session transcript on disk, needs real prior turns. Making `historyNative` a capability lets those cases say so and be not applicable elsewhere, instead of grading a run that could not succeed.

Conditional replies exist because several cases pass when the agent stops and asks. A fixed list of turns cannot answer a question that may not be asked.

## Alternatives rejected

- **Replaying history as real turns.** The model's replies would differ from the seeded ones, and every replay costs tokens.
- **One long-lived process fed turns on standard input.** Not every CLI has a streaming input mode, and a hang would lose the whole session.
- **Only a preamble.** It is wrong for the skills named above.
- **A workspace copy after each turn.** No case needs it. A hash manifest answers "turn 1 changed nothing under `src/`" at a fraction of the cost.
- **Treating a turn-limit hit as invalid.** Running out of turns is agent behaviour.
- **Treating a final message that ends with a question mark as asking the user.** It would misfire on rhetorical questions. Only the harness's question tool counts.

## What it costs

- Each CLI's continuation flag, session store layout and lifecycle commands must be confirmed from that CLI. Until then the capability stays undeclared.
- Results under `native` and `preamble` are not comparable. The report shows the mode, and the flag forces the common one.
- Per-turn file checks see hashes, so they can say what changed in a turn, not what a file held mid-run.
- A skipped conditional turn leaves its checks unscored. The report says so.
