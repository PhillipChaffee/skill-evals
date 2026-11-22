# The transcript model

## Decision

Every adapter turns its harness's stream into one ordered list of events. Checks, the judge and the command graders all read that list. Nothing else reads the raw stream.

```ts
interface TranscriptEvent {
  index: number; // position in the run
  turn: number | null; // assistant turn; null where the harness has no grouping
  userTurn: number; // which user message this answers; 0 for a single prompt
  role: "user" | "assistant" | "tool" | "system";
  agent: AgentRef; // who produced it
  type: "text" | "tool_call" | "tool_result" | "hook" | "lifecycle";
  callId?: string; // joins a tool_call to its tool_result
  kind?: ToolKind;
  name?: string;
  input?: unknown;
  output?: string;
  text?: string;
  bytes?: number; // original size
  truncated?: boolean;
  durationMs?: number; // on tool_result, where the stream has it
}
```

`Parsed.toolCalls` is always derived from the transcript with `callsOf`. Adapters do not build it themselves. A 0.0.1 record's `toolCalls` keeps its shape; the new fields on a call are optional.

### Fidelity and size

- The full transcript is written to `<label><rep>.transcript.json` beside the stream file. The file on disk is never cut.
- In `results.json`, a run record keeps `toolCalls` with inputs and no outputs, and `transcriptFile`.
- A single `text` or `output` longer than 20,000 bytes is cut in the in-memory copy handed to the judge. Every cut sets `truncated: true` and keeps `bytes`.
- The judge's rendering has its own cap, 60,000 characters by default. Outputs are cut to 400 characters first, then the oldest tool outputs are dropped. The rendering says what it left out.
- Pattern checks run on text capped at 1 MB for each event.
- Streams are decoded with replacement, so invalid UTF-8 never throws.

### What an adapter supplies

Each piece is a capability, earned by a parser test on a fixture stream: `assistantText`, `toolOutputs`, `turnGrouping`, `toolDurations`, `hooks`. A check that needs a piece the harness lacks makes its case not applicable there.

`first_message` means the first non-empty assistant text of the main agent, wherever it falls. In the consumer's kit the first action is a tool call, so text before the first tool call is normally empty.

## Why

0.0.1 saw the final answer and tool inputs. Claims such as "the command's own output showed a failure before the fix" need tool outputs. Claims such as "the first message restated the goal" need intermediate text. A judge that sees only the final answer grades self-report.

One model for all five harnesses keeps every check harness-neutral. A check never knows which CLI produced the event.

Deriving `toolCalls` from the transcript removes the chance that the two disagree.

## Alternatives rejected

- **Keeping `toolCalls` and adding separate lists for text and outputs.** Order across the lists would be lost, and order is what most new checks ask about.
- **Putting the whole transcript in `results.json`.** A 400-case run would produce a file too large to diff or load.
- **Cutting the transcript on disk.** `rejudge` and command graders need the full text.
- **Letting checks read the raw stream.** Every check would then need five implementations.
- **Guessing turn grouping where the stream has none.** A wrong `sameTurn` verdict is worse than "not applicable".

## What it costs

- Every adapter's parser is rewritten once, and each needs fixture streams that show outputs and text.
- A transcript file for each run. Large tool outputs make large files.
- Truncation for the judge means a judge can miss evidence in a long output. The rendering states what was dropped, and deterministic checks see the full text up to their cap.
