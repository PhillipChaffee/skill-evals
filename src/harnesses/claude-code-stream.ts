import { GENERIC_AGENT, MAIN_AGENT, normalizeAgent } from "../agents.js";
import type { EventInput } from "../transcript.js";
import { callPart, resultPart, textPart } from "../transcript.js";
import type {
  AgentRef,
  Dispatch,
  Tokens,
  ToolKind,
  TurnState,
} from "./shared.js";
import { joinText } from "./shared.js";

/** A content block of an `assistant` or `user` event; which fields are set depends on its type. */
interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** The token counts of one assistant message. */
interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** The events of the stream that carry a message. */
export interface MessageEvent {
  type: string;
  session_id?: string;
  /** The id of the dispatching call, on an event that a subagent produced; null on the main thread's. */
  parent_tool_use_id?: string | null;
  message?: {
    id?: string;
    content?: Block[] | string;
    usage?: MessageUsage;
  };
}

/**
 * Names the agent that a dispatch starts.
 * @param call - The dispatching call.
 * @param call.id - The id of the call, which becomes the agent's id.
 * @param call.input - The call's input; its `subagent_type` is the agent's type.
 * @param dispatcher - The agent that made the call.
 * @returns The agent: its type normalized, one level below the dispatcher.
 */
function agentOf(
  call: { id: string; input: unknown },
  dispatcher: AgentRef,
): AgentRef {
  const { subagent_type: named } = Object(call.input) as Record<
    string,
    unknown
  >;
  return {
    id: call.id,
    type:
      typeof named === "string" && named !== ""
        ? normalizeAgent(named)
        : GENERIC_AGENT,
    parent: dispatcher.id,
    depth: dispatcher.depth + 1,
  };
}

/**
 * Reads what a dispatch call chose for its agent.
 * @param input - The call's input; its `subagent_type`, `model` and `effort` are read where they are non-empty text.
 * @returns The dispatch, with null for each choice the input does not show.
 */
function dispatchOf(input: unknown): Dispatch {
  const given = Object(input) as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = given[key];
    return typeof value === "string" && value !== "" ? value : null;
  };
  return {
    type: text("subagent_type"),
    model: text("model"),
    effort: text("effort"),
  };
}

/**
 * Adds the dispatch to the part of a dispatch call.
 * @param part - The part of a tool call.
 * @param input - The call's input.
 * @returns The part, with `dispatch` when it is a `subagent` call.
 */
const withDispatch = (part: EventInput, input: unknown): EventInput =>
  part.kind === "subagent" ? { ...part, dispatch: dispatchOf(input) } : part;

/**
 * Finds the agent that an event belongs to.
 * @param parent - The event's `parent_tool_use_id`.
 * @param agents - The agents that earlier dispatch calls started, by the id of the call.
 * @returns The main thread for no parent; the agent that the call of that id started; an agent of type `unknown` one
 *   level below the main thread for an id no earlier call started.
 */
function ownerOf(
  parent: string | null | undefined,
  agents: Map<string, AgentRef>,
): AgentRef {
  if (!parent) return MAIN_AGENT;
  return (
    agents.get(parent) ?? {
      id: parent,
      type: "unknown",
      parent: MAIN_AGENT.id,
      depth: 1,
    }
  );
}

/**
 * Reads what a tool result holds.
 * @param content - A string, or a list of blocks of which the text ones count.
 * @returns The text; empty for a result with none.
 */
function resultText(content: unknown): string {
  return typeof content === "string" ? content : joinText(content);
}

/**
 * Reads the text, tool calls and tool results of a stream, with the assistant turn of each.
 * @param events - The events of the stream, in order.
 * @param kinds - The adapter's table of native tool name to kind.
 * @returns The parts of the transcript, a subagent's included, each with its agent: an event whose
 *   `parent_tool_use_id` is set belongs to the agent that the call of that id started, and an id that no earlier call
 *   started gives an agent of type `unknown` one level below the main thread. A dispatch call and its result belong to
 *   the dispatcher. A turn is one assistant message: the counter, from 1,
 *   moves on at each `message.id` it has not seen, so the blocks of one message share a turn even when the stream splits
 *   them over several events. An assistant event without an id is a turn of its own. A tool result takes the turn of its call, in `numbered`.
 */
export function transcriptParts(
  events: MessageEvent[],
  kinds: Record<string, ToolKind>,
): EventInput[] {
  const turns = new Map<string, number>();
  const agents = new Map<string, AgentRef>();
  const callAgents = new Map<string, AgentRef>();
  let turn = 0;
  return events.flatMap((one): EventInput[] => {
    const parent = one.parent_tool_use_id;
    const agent = ownerOf(parent, agents);
    // A result with no parent id belongs to the agent that made its call, which is the main thread for a dispatch's.
    const ofResult = (use: string | undefined): AgentRef =>
      parent || use === undefined ? agent : (callAgents.get(use) ?? agent);
    const blocks = Array.isArray(one.message?.content)
      ? one.message.content
      : [];
    if (one.type === "user") {
      return blocks
        .filter((block) => block.type === "tool_result")
        .map((block) =>
          resultPart(
            block.tool_use_id,
            block.content === undefined ? undefined : resultText(block.content),
            {
              agent: ofResult(block.tool_use_id),
              ...(block.is_error === undefined
                ? {}
                : { isError: block.is_error }),
            },
          ),
        );
    }
    if (one.type !== "assistant") return [];
    const id = one.message?.id;
    const known = id === undefined ? undefined : turns.get(id);
    const current = known ?? ++turn;
    if (id !== undefined) turns.set(id, current);
    return blocks.flatMap((block): EventInput[] => {
      if (block.type === "tool_use") {
        const { id: callId, name = "", input } = block;
        const part = callPart(
          kinds,
          { name, input, callId },
          { turn: current, agent },
        );
        if (callId !== undefined) callAgents.set(callId, agent);
        if (part.kind === "subagent" && callId !== undefined) {
          agents.set(callId, agentOf({ id: callId, input }, agent));
        }
        return [withDispatch(part, input)];
      }
      return block.type === "text" && block.text
        ? [textPart(block.text, { turn: current, agent })]
        : [];
    });
  });
}

/**
 * Counts the main-thread turns of a stream as its lines arrive: one for each assistant message id not seen before, and
 * one for each assistant event with no id. An event of a subagent (it has a `parent_tool_use_id`) never counts.
 * @param line - One parsed line of the stream.
 * @param state - Raises `turns`; remembers the message ids in `seen`.
 */
export function countTurns(line: unknown, state: TurnState): void {
  const one = Object(line) as MessageEvent;
  if (one.type !== "assistant" || one.parent_tool_use_id) return;
  const id = one.message?.id;
  if (id !== undefined) {
    if (state.seen.has(id)) return;
    state.seen.add(id);
  }
  state.turns += 1;
}

/**
 * Adds up the usage of each assistant message by the agent that produced it.
 * @param events - The events of the stream, in order.
 * @returns Agent id (`main`, or the id of the dispatch call) to its tokens, input counting cached tokens as the run's
 *   total does. A message that the stream states in several events counts once, at its last statement. Null when no
 *   assistant message carries usage.
 */
export function agentTokens(
  events: MessageEvent[],
): Record<string, Tokens> | null {
  const stated = new Map<string, { agent: string; usage: MessageUsage }>();
  events.forEach((one, position) => {
    const usage = one.message?.usage;
    if (one.type !== "assistant" || !usage) return;
    stated.set(one.message?.id ?? `event ${String(position)}`, {
      agent: one.parent_tool_use_id || MAIN_AGENT.id,
      usage,
    });
  });
  if (stated.size === 0) return null;
  const totals: Record<string, Tokens> = {};
  for (const { agent, usage } of stated.values()) {
    const total = (totals[agent] ??= { input: 0, output: 0 });
    total.input +=
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    total.output += usage.output_tokens ?? 0;
  }
  return totals;
}
