import path from "node:path";
import type { EventInput } from "../transcript.js";
import {
  callPart,
  callsOf,
  numbered,
  resultPart,
  textPart,
} from "../transcript.js";
import type { Harness, ToolKind } from "./shared.js";
import {
  NOT_REPORTED,
  jsonLines,
  opt,
  placeSkills,
  pluginDir,
  stringArg,
  toolCall,
} from "./shared.js";

const KINDS: Record<string, ToolKind> = {
  shell: "shell",
  read: "read",
  write: "write",
  edit: "edit",
  delete: "edit",
  grep: "search",
  glob: "search",
  ls: "search",
  semSearch: "search",
  webSearch: "web",
  webFetch: "web",
  task: "subagent",
};

/** The body of a tool call. A built-in tool has `args`; an MCP tool, under the key `function`, has the other two. */
interface CallBody {
  args?: unknown;
  name: string;
  arguments: string;
}

/** The events of `--output-format stream-json` that the adapter reads. */
type Event =
  | { type: "result"; subtype: string; result?: string; is_error?: boolean }
  | { type: "assistant"; message: { content: { text?: string }[] } }
  | {
      type: "tool_call";
      subtype: string;
      call_id?: string;
      tool_call: Record<string, CallBody & { result?: unknown }>;
    };

/**
 * Reads a tool call, which Cursor nests under a key that names the tool.
 * @param call - One entry: `<tool>ToolCall` for a built-in tool, `function` for an MCP tool with JSON-encoded arguments.
 * @returns The tool's name, its input (arguments that are not JSON stay text), and what it returned, if anything.
 * @throws {TypeError} For a call that names no tool.
 */
function nativeCall(call: Record<string, CallBody & { result?: unknown }>): {
  name: string;
  input: unknown;
  result: unknown;
} {
  const [entry] = Object.entries(call);
  if (!entry) throw new TypeError("a tool call that names no tool");
  const [key, body] = entry;
  if (key !== "function") {
    return {
      name: key.replace(/ToolCall$/, ""),
      input: body.args,
      result: body.result,
    };
  }
  try {
    return {
      name: body.name,
      input: JSON.parse(body.arguments),
      result: body.result,
    };
  } catch {
    return { name: body.name, input: body.arguments, result: body.result };
  }
}

/**
 * Reads the transcript parts of a stream.
 * @param events - The events of the stream, in order.
 * @returns The text of each `assistant` event, a call for each `started` tool call, and for each `completed` one a
 *   result, which is the JSON of what the tool reported.
 */
function transcriptParts(events: Event[]): EventInput[] {
  return events.flatMap((e): EventInput[] => {
    if (e.type === "assistant") {
      const text = e.message.content.map((part) => part.text ?? "").join("");
      return text ? [textPart(text)] : [];
    }
    if (e.type !== "tool_call") return [];
    const started = e.subtype === "started";
    // A completed event that names no tool has nothing to report; a started one that names none is a stream error.
    if (!started && Object.keys(e.tool_call).length === 0) return [];
    const { name, input, result } = nativeCall(e.tool_call);
    if (started) {
      return [callPart(KINDS, { name, input, callId: e.call_id })];
    }
    if (e.subtype !== "completed") return [];
    const output = result === undefined ? "" : JSON.stringify(result);
    const { kind } = toolCall(KINDS, name, input);
    return [resultPart(e.call_id, output, { name, kind })];
  });
}

const cursor: Harness = {
  id: "cursor",
  bin: "cursor-agent",
  // Cursor's read tool takes `path` (seen in test/fixtures/cursor.stream.jsonl).
  pathOf: (call) => stringArg(call, ["path"]),
  authFiles: [".cursor/auth.json", ".config/cursor/auth.json"],
  authEnv: ["CURSOR_API_KEY"],
  capabilities: new Set(["subagents"]),
  status: "unverified",

  invocation({ subject, home, workspace, prompt, model }) {
    const placed = placeSkills(subject, path.join(home, ".cursor", "skills"));
    return {
      placed,
      args: [
        "-p",
        "--output-format",
        "stream-json",
        ...opt("--plugin-dir", pluginDir(subject)),
        "--force",
        "--trust",
        "--workspace",
        workspace,
        ...opt("--model", model),
        "--",
        prompt,
      ],
      env: { CURSOR_CONFIG_DIR: path.join(home, ".cursor") },
    };
  },

  parse(stdout) {
    const events = jsonLines(stdout) as Event[];
    const result = events.filter((e) => e.type === "result").at(-1);
    const transcript = numbered(transcriptParts(events));
    const lastMessage = events.filter((e) => e.type === "assistant").at(-1);
    const failure = result?.is_error ? result.result || result.subtype : null;
    return {
      // The result event joins every message of the run; the last assistant event is the final one.
      finalText: lastMessage
        ? lastMessage.message.content.map((part) => part.text ?? "").join("")
        : (result?.result ?? ""),
      toolCalls: callsOf(transcript),
      transcript,
      sessionId: null,
      tokens: null,
      costUsd: null,
      loaded: NOT_REPORTED,
      error: result ? failure : "no result event",
    };
  },
};

export default cursor;
