import type { ToolKind } from "../harnesses/shared.js";
import type { EventInput } from "../transcript.js";
import { callPart, callsOf, numbered, resultPart } from "../transcript.js";
import { bareOutcome } from "./outcome.js";

const KINDS: Record<string, ToolKind> = {
  Bash: "shell",
  Edit: "edit",
  Read: "read",
  Skill: "skill",
};

/**
 * States a tool call of a hand-built transcript.
 * @param name - `Bash`, `Edit`, `Read` or `Skill`.
 * @param input - The arguments of the call.
 * @param id - The id that joins the call to its result.
 * @returns The event, to give to `played`.
 */
export const call = (name: string, input: unknown, id: string): EventInput =>
  callPart(KINDS, { name, input, callId: id });

/**
 * States the result of a tool call of a hand-built transcript.
 * @param id - The id of the call it answers.
 * @param output - What the tool returned; undefined for a result with no output.
 * @returns The event, to give to `played`.
 */
export const result = (id: string, output: string | undefined): EventInput =>
  resultPart(id, output);

/**
 * Makes an outcome from the events of a hand-built transcript.
 * @param parts - The events, in order.
 * @returns An outcome that holds them as its transcript and the calls among them as its tool calls.
 */
export function played(...parts: EventInput[]) {
  const transcript = numbered(parts);
  return { ...bareOutcome(), transcript, toolCalls: callsOf(transcript) };
}
