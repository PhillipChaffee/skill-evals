import { MAIN_AGENT, normalizeAgent } from "../agents.js";
import type { EventInput } from "../transcript.js";
import { callPart, resultPart, textPart } from "../transcript.js";
import type { AgentRef, ToolKind } from "./shared.js";
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

/** The events of the stream that carry a message. */
export interface MessageEvent {
  type: string;
  session_id?: string;
  /** The id of the dispatching call, on an event that a subagent produced; null on the main thread's. */
  parent_tool_use_id?: string | null;
  message?: { id?: string; content?: Block[] | string };
}

/** A dispatch that names no agent type starts this one. */
const GENERIC_AGENT = "general-purpose";

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
        return [part];
      }
      return block.type === "text" && block.text
        ? [textPart(block.text, { turn: current, agent })]
        : [];
    });
  });
}
