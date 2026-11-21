import path from "node:path";
import type { Harness, ToolCall, ToolKind } from "./shared.js";
import { jsonLines, opt, placeSkills, pluginDir, toolCall } from "./shared.js";

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
  | { type: "tool_call"; subtype: string; tool_call: Record<string, CallBody> };

/**
 * Normalizes a tool call, which Cursor nests under a key that names the tool.
 * @param call - One entry: `<tool>ToolCall` for a built-in tool, `function` for an MCP tool with JSON-encoded arguments.
 * @returns The call. Arguments that are not JSON stay text.
 */
function nativeCall(call: Record<string, CallBody>): ToolCall {
  const [entry] = Object.entries(call);
  if (!entry) throw new TypeError("a tool call that names no tool");
  const [key, body] = entry;
  if (key !== "function") {
    return toolCall(KINDS, key.replace(/ToolCall$/, ""), body.args);
  }
  try {
    return toolCall(KINDS, body.name, JSON.parse(body.arguments));
  } catch {
    return toolCall(KINDS, body.name, body.arguments);
  }
}

const cursor: Harness = {
  id: "cursor",
  bin: "cursor-agent",
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
    const lastMessage = events.filter((e) => e.type === "assistant").at(-1);
    const failure = result?.is_error ? result.result || result.subtype : null;
    return {
      // The result event joins every message of the run; the last assistant event is the final one.
      finalText: lastMessage
        ? lastMessage.message.content.map((part) => part.text ?? "").join("")
        : (result?.result ?? ""),
      toolCalls: events
        .filter((e) => e.type === "tool_call")
        .filter((e) => e.subtype === "started")
        .map((e) => nativeCall(e.tool_call)),
      tokens: null,
      costUsd: null,
      loaded: { paths: null, skills: null },
      error: result ? failure : "no result event",
    };
  },
};

export default cursor;
