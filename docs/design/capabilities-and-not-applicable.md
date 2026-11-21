# Capabilities and not-applicable cases

## Decision

Each harness adapter declares a set of capabilities. The names are fixed in `src/capabilities.ts`: `subagents`, `multiTurn`, `userInvoke`, `toolOutputs`, `assistantText`, `turnGrouping`, `childCalls`, `childText`, `rules`, `hooks`, `history`, `historyNative`, `askUser`, `toolDurations`, `sessionStore`, `compact`, `clear`, `resume`, `mcp`, `skillListing`, `loadedReport`, `isolated`, `sandbox`. Host capabilities share the namespace as `bin:<name>`, an executable on `PATH`.

An adapter declares a capability only when a parser test proves it on a stream.

Applicability is decided for each pair of harness and case, before any run. What the case needs is its `requires` list plus what its checks imply. A check with `sameTurn` needs `turnGrouping`. A check with `by` needs `childCalls`. A check on tool output needs `toolOutputs`.

A case that needs something the harness lacks is **not applicable** there. It has no runs and no score. The report lists it with the missing capabilities. It is never a pass and never a failure.

Applicability is case-level by default. One check that needs a missing capability makes the whole case not applicable.

A check may opt out with `"ifUnsupported": "skip"`. On a harness that lacks what the check needs, that one check is dropped and the remaining weights are re-normalized. The report lists the case under "Ran with checks skipped" and names the skipped checks. A case whose every check would be skipped is not applicable.

A `harnesses` list on a case is a last resort. It must carry a `note`, and the note is the reason shown.

### Scores across harnesses

Each harness's suite score is over its own applicable set. It is printed as `score (n of N cases)`. When more than one harness runs, the report adds a common-set score over the cases that apply to all of them. Only that number compares harnesses.

### Invalid versus zero

Infrastructure and preconditions invalidate a run. Agent behaviour scores it.

A run is invalid when:

- the harness failed or hit the time limit;
- a setup step failed;
- a precondition was not met;
- the harness reported what it loaded and the subject was not in it;
- anything outside the subject loaded under `--isolated`;
- a judged check or a decision check got no usable answer.

A run is scored when:

- a `command` check timed out or could not start: that check scores 0 with the reason;
- the run hit `maxTurns`: it is scored, and `stoppedBy: "maxTurns"` is shown;
- the agent edited the subject copy: the run is scored and flagged.

A time limit stays invalid because 0.0.1 treats it so. A case can set `onTimeout: "score"` when stalling is the behaviour under test.

## Why

A missing capability must never turn into a silent pass. A check that cannot see child tool calls would report "no subagent edited a file" for every run. Excluding the case is the only honest result.

Deciding before the run costs nothing and spends no model budget on a case that cannot be graded.

The per-check opt-out exists because the consumer's suite has 30 to 40 cases that are portable except for one capability-bound check. Without it, authors would split each into two cases and pay for two agent runs.

## Alternatives rejected

- **Per-check exclusion as the default.** Re-weighting without the author asking means one case name scores different things on different harnesses.
- **Scoring an unsupported check as 0.** It would read as the agent failing.
- **Scoring it as 1.** That is the silent pass the ground rules forbid.
- **Deciding applicability at run time from the stream.** It spends a run to learn what the adapter already knows.
- **Comparing each harness's own suite score.** The sets differ, so the numbers are not comparable. The common-set score is.

## What it costs

- Until the other four harnesses are verified with real streams, most new-feature cases read "not applicable" outside Claude Code.
- Authors must know which checks imply which capability. `explain` and `validate` print it.
- A skipped check changes what a case's score means on that harness. The report says so every time.
