# Agent attribution

## Decision

Every transcript event and every tool call carries the agent that produced it.

```ts
interface AgentRef {
  id: string; // "main", or the id of the dispatching tool call
  type: string; // normalized agent name; "main" for the main thread
  parent: string | null; // the dispatching agent's id
  depth: number; // 0 is the main thread
}
```

The main thread is `{ id: "main", type: "main", parent: null, depth: 0 }`.

Agent names are normalized the way skill names are: the part after the last colon. `magic:comment-sicko:comment-sicko` and `comment-sicko` are the same agent.

On Claude Code, an event with `parent_tool_use_id` belongs to the agent whose `id` is that tool-use id. Its `type` comes from the dispatching call's agent type. Depth follows the chain of parents.

### Scoping checks

Every tool-call matcher, and `transcript_matches` and `transcript_lacks`, accept `by`:

- `"main"`: the main thread only.
- `"subagent"`: any agent with depth above 0.
- `{ "agent": "<name>" }`: agents of that normalized type.

A matcher with no `by` matches calls by any agent, as in 0.0.1.

### Dispatch

`agent_dispatched` counts dispatches of a named agent. It matches a subagent call whose normalized type equals the name. As a fallback, when the dispatch names a generic type or none, it matches when:

- a line `name: <agent>` appears anywhere in the brief, or
- the agent name appears as a whole word in the brief's first 400 characters.

The window is settable on the check with `briefWindow`. The check's reason says which rule matched.

Each dispatch records `{ type, model, effort }` where the harness exposes them. The record keeps tokens for each agent where the stream reports them.

A role with no agent type is matched by brief content and order, with `tool_called` and `tool_order`.

### Capabilities

- `subagents`: the dispatch call is visible.
- `childCalls`: the child's tool calls are visible and attributed.
- `childText`: the child's text is visible.

`by: "main"` needs `childCalls`. Without it, "the main thread made no edit" cannot be told from "nobody did".

## Why

0.0.1 flattened subagent calls into the parent's list. "The researcher never edited a file" and "the main thread delegated the edit" were both unanswerable. A `tool_not_called` check also fired on something a subagent did legitimately.

Using the dispatching call's id as the agent id needs no invented identifier and joins a child to its dispatch for free.

Normalizing names keeps cases free of plugin prefixes, which differ by how the kit is installed.

## Alternatives rejected

- **A flag `fromSubagent: boolean` on each call.** It cannot tell two researchers apart or express nesting.
- **Separate transcripts for each agent.** Order between a parent and its children would be lost. "The synthesizer ran after all researchers" needs one ordered list.
- **Matching agent names as raw strings.** Cases would break when the plugin prefix changes.
- **Matching an inlined definition by bare name anywhere in the brief.** A brief that only mentions another agent would count as dispatching it.
- **Treating a missing `by` as "main".** It would change what every 0.0.1 `tool_called` check means.

## What it costs

- Outside Claude Code, only the dispatch is visible today. Cases with `by` are not applicable on those harnesses until real streams prove otherwise.
- The inlined-definition fallback is a heuristic. A brief that puts the name late and has no `name:` line is missed. The reason text makes a fallback match visible.
- Existing fixtures have scrubbed ids. Attribution tests need fixtures with distinct, stable ids.
