import { HARNESSES } from "../harnesses/index.js";
import type { ReferencePage } from "./markdown.js";
import { FENCE, code, header, table } from "./markdown.js";

// The capabilities that decide what a harness puts in its transcript, with the part of the transcript each one fills.
const FILLED = {
  assistantText: "Assistant text between tool calls",
  toolOutputs: "Tool outputs",
  turnGrouping: "Assistant turn on each event",
  toolDurations: "Tool duration",
} as const;

/**
 * Writes the per-harness table: what each adapter puts in the transcript.
 * @returns A Markdown table. A tool call is always captured; every other row is a capability the adapter declares.
 */
const captured = (): string =>
  table(
    ["Captured", ...HARNESSES.map((harness) => code(harness.id))],
    [
      ["Tool calls with their input", ...HARNESSES.map(() => "yes")],
      ...Object.entries(FILLED).map(([name, label]) => [
        label,
        ...HARNESSES.map((harness) =>
          (harness.capabilities as ReadonlySet<string>).has(name)
            ? "yes"
            : "no",
        ),
      ]),
    ],
  );

/**
 * Writes the page about the transcript.
 * @returns The page, with its table written from what each adapter declares.
 */
export const transcriptPage = (): ReferencePage => ({
  file: "concepts/transcript.md",
  markdown: `${header(
    {
      title: "The transcript",
      description:
        "The one list of events that every harness adapter writes for a run, and what each harness puts in it.",
    },
    "src/transcript.ts and src/harnesses/",
  )}

Every adapter turns the stream of its harness into one ordered list of events. An event is the assistant's text, a tool call, or a tool result. Checks and graders read that list, and nothing else reads the raw stream. A check never needs to know which CLI wrote the events.

The tool calls in a run record are always taken from the transcript, so the two cannot disagree.

## Where it is written

The whole transcript is written to ${code("<label><rep>.transcript.json")}, next to the stream file, before any check runs. The file is pretty JSON and is never cut. The run record in ${code("results.json")} has ${code("transcriptFile")}: the path of that file, relative to the output directory. A run that could not be scored has ${code("null")}.

A ${code("command")} check gets the absolute path of the file in ${code("SKILL_EVALS_TRANSCRIPT")}.

${FENCE}json
{
  "checks": [
    {
      "type": "command",
      "run": "grep -q 'npm test' \\"$SKILL_EVALS_TRANSCRIPT\\"",
      "timeoutSeconds": 30
    }
  ]
}
${FENCE}

## The events

Each event has ${code("index")}, ${code("turn")} (null where the harness does not group calls; a tool result has the turn of its call), ${code("userTurn")}, ${code("role")}, ${code("agent")}, ${code("type")} and these fields where they apply:

- ${code("callId")} joins a tool call to its tool result.
- ${code("kind")}, ${code("name")} and ${code("input")} describe the call. A tool result takes the name and kind of its call.
- ${code("output")} is what the tool returned. ${code("isError")} is true when the harness marked the call as failed.
- ${code("text")} is what the assistant said.
- ${code("bytes")} is the size in UTF-8 of the ${code("text")} or ${code("output")} as decoded, before any cut.
- ${code("durationMs")} is how long a tool call took, where the stream says.

A case with a ${code("history.json")} keeps its seeded messages out of this file: the file holds the agent's events only, numbered from 0 as the reasons of the checks quote them. The messages are in ${code("<label><rep>.history.json")} next to it, as ${code("history.json")} has them, and a ${code("command")} check gets that path in ${code("SKILL_EVALS_HISTORY")} (not set for a case with no history). No check reads the history: ${code("tool_called")}, ${code("tool_order")}, the skill checks, ${code("transcript_matches")}, the output checks, ${code("agent_dispatched")} and ${code("asked_user")} see the agent's events only, and ${code("rejudge")} and ${code("rescore")} read the same files. The judge sees no history in this release, and its task text is the case's prompt without the block. ${code("show")} prints the agent's events at their own index and the history after a heading as ${code("h0")}, ${code("h1")} and so on, with each message's role. See [Multi-turn cases](../guides/multi-turn.md#start-from-a-conversation-that-already-happened).

Every event carries the agent that produced it: ${code("agent")} is ${code("{ id, type, parent, depth }")}, and the main thread is ${code('{ "id": "main", "type": "main", "parent": null, "depth": 0 }')}. Claude Code attributes child events: an event with a ${code("parent_tool_use_id")} belongs to the agent that the call of that id started, and it declares ${code("childCalls")} and ${code("childText")}. Every other adapter attributes every event to the main agent and declares neither capability, so a check with ${code("by")} is not applicable there. A call of kind ${code("subagent")} also records ${code("dispatch")}, ${code("{ type, model, effort }")}: what its input chose for the agent, each null where the stream does not show it (Claude Code reads ${code("subagent_type")}, ${code("model")} and ${code("effort")}; the other adapters show none). ${code("agent_dispatched")} reads it. Where the stream reports usage on each assistant message (Claude Code), the run record's ${code("agentTokens")} sums it by agent id, ${code("main")} or the id of the dispatch call; it is null elsewhere, and ${code("tokens")} stays the run's own total. A run record keeps ${code("toolCalls")} with their inputs and never their outputs.

## What each harness puts in it

${captured()}

An adapter declares a capability only when a parser test proves it on a fixture stream. ${code("test/fixtures/README.md")} says which fixtures were captured from a real CLI and which were written from the CLI's documentation. A check that needs a part that its harness lacks makes its case not applicable there. See [Capabilities](capabilities.md).

A tool matcher or a check on tool calls can bound a call's duration with ${code("minDurationMs")} and ${code("maxDurationMs")}. That needs ${code("toolDurations")}; a call whose duration is unknown never fits a bound.

A skill-tool call whose tool result was an error is not resolved, on a harness that has ${code("toolOutputs")}. Elsewhere the rule is the one it was.

## Checks that read it

${code("transcript_matches")}, ${code("transcript_lacks")}, ${code("tool_output_matches")}, ${code("tool_output_lacks")} and ${code("tool_output_size")} read these events. They need ${code("assistantText")} or ${code("toolOutputs")}, as the table says. A pattern sees at most the first 1,000,000 characters of one event's text, input or output. See [Write a case](../guides/write-a-case.md#what-the-agent-said-and-what-its-tools-returned).

## Size and bad bytes

The copy of the transcript that is handed to a judge cuts any single ${code("text")} or ${code("output")} longer than 20,000 bytes. A cut event has ${code("truncated: true")} and keeps its original ${code("bytes")}. The file on disk is never cut.

The output of a harness is decoded as UTF-8 with replacement, so a tool that prints invalid bytes never makes a run fail. Each invalid byte sequence becomes one U+FFFD character, which is three bytes in UTF-8, so a truncated sequence such as ${code("E2 82")} is one replacement character. ${code("bytes")} counts the text as it was decoded, not the raw bytes the tool wrote.
`,
});
