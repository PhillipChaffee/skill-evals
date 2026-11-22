import type { EventInput } from "../transcript.js";
import { callPart, joinText, resultPart, textPart } from "../transcript.js";
import type { ToolKind } from "./shared.js";

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
  message?: { id?: string; content?: Block[] | string };
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
 * @returns The parts of the transcript, a subagent's included. A turn is one assistant message: the counter, from 1,
 *   moves on at each `message.id` it has not seen, so the blocks of one message share a turn even when the stream splits
 *   them over several events. An assistant event without an id is a turn of its own. A tool result has no turn.
 */
export function transcriptParts(
  events: MessageEvent[],
  kinds: Record<string, ToolKind>,
): EventInput[] {
  const turns = new Map<string, number>();
  let turn = 0;
  return events.flatMap((one): EventInput[] => {
    const blocks = Array.isArray(one.message?.content)
      ? one.message.content
      : [];
    if (one.type === "user") {
      return blocks
        .filter((block) => block.type === "tool_result")
        .map((block) =>
          resultPart(block.tool_use_id, resultText(block.content), {
            ...(block.is_error === undefined
              ? {}
              : { isError: block.is_error }),
          }),
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
        return [callPart(kinds, { name, input, callId }, { turn: current })];
      }
      return block.type === "text" && block.text
        ? [textPart(block.text, { turn: current })]
        : [];
    });
  });
}
