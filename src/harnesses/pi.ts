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
  ANTHROPIC_ENV,
  OPENAI_ENV,
  jsonLines,
  joinText,
  opt,
  placeSkills,
  pluginDir,
  sumTokens,
  stringArg,
} from "./shared.js";

const KINDS: Record<string, ToolKind> = {
  bash: "shell",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "search",
  find: "search",
  ls: "search",
};
const FAILED = new Set(["error", "aborted"]);

/** The message of a finished turn. */
interface Message {
  role?: string;
  content?: { type: string; text?: string }[];
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost?: { total?: number };
  };
  stopReason: string;
  errorMessage?: string;
}

/** The events of `pi --mode json` that the adapter reads. */
type Event =
  | { type: "session"; id?: string }
  | { type: "turn_end"; message?: Message }
  | { type: "message_end"; message?: Message }
  | {
      type: "tool_execution_start";
      toolCallId?: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId?: string;
      isError?: boolean;
      result?: { content?: unknown };
    };

/**
 * Reads the transcript parts of a stream.
 * @param events - The events of the stream, in order.
 * @returns A call for each `tool_execution_start`, a result for each `tool_execution_end` (with an `output` only when
 *   the event has a `result`), and the text of each assistant `message_end`, where that event sits, which is before
 *   the tool events of its message. The `turn` of an event is the number of `turn_end` events seen before it, so the
 *   calls before the first `turn_end` are in turn 0.
 */
function transcriptParts(events: Event[]): EventInput[] {
  let ended = 0;
  let seen = false;
  return events.flatMap((e): EventInput[] => {
    if (e.type === "tool_execution_start") {
      const { toolName: name, args: input, toolCallId: callId } = e;
      return [callPart(KINDS, { name, input, callId }, { turn: ended })];
    }
    if (e.type === "tool_execution_end") {
      const output = e.result ? joinText(e.result.content) : undefined;
      return [
        resultPart(e.toolCallId, output, { isError: e.isError === true }),
      ];
    }
    if (e.type !== "message_end" && e.type !== "turn_end") return [];
    if (e.message?.role !== "assistant") {
      if (e.type === "turn_end") ended += 1;
      return [];
    }
    const text = joinText(e.message.content);
    // A turn_end repeats its message, so it adds text only when no message_end of the turn was seen (an older CLI).
    const repeats = e.type === "turn_end" && seen;
    seen = e.type === "message_end";
    const turn = ended;
    if (e.type === "turn_end") ended += 1;
    return text && !repeats ? [textPart(text, { turn })] : [];
  });
}

const pi: Harness = {
  id: "pi",
  bin: "pi",
  // Pi's read tool takes `path` (seen in test/fixtures/pi.stream.jsonl).
  pathOf: (call) => stringArg(call, ["path"]),
  authFiles: [".pi/agent/auth.json", ".pi/agent/models.json"],
  authEnv: [...ANTHROPIC_ENV, ...OPENAI_ENV],
  capabilities: new Set(["toolOutputs", "assistantText", "turnGrouping"]),
  status: "scripted",
  isolationGap:
    "It is always started with discovery switched off (`-ne -ns -np`), whatever the flag says, and that stays its default. It reports nothing it loaded, so it cannot run `--isolated` until an adapter can prove what it loaded.",

  invocation({ subject, home, prompt, model }) {
    const agentDir = path.join(home, ".pi", "agent");
    const skills = placeSkills(subject, path.join(agentDir, "skills"));
    return {
      placed: skills,
      args: [
        "-p",
        "--mode",
        "json",
        "--no-session",
        // -ne, -ns and -np switch off discovery, so what -e and --skill name is all that loads.
        "-ne",
        "-ns",
        "-np",
        ...opt("-e", pluginDir(subject)),
        ...Object.values(skills).flatMap((dir) => ["--skill", dir]),
        ...opt("--model", model),
      ],
      // Pi has no `--` separator and reads a leading `-` or `@` in a message argument as a flag or a file.
      stdin: prompt,
      env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
    };
  },

  parse(stdout) {
    const events = jsonLines(stdout) as Event[];
    const turns = events
      .filter((e) => e.type === "turn_end")
      .flatMap((e) => (e.message?.role === "assistant" ? [e.message] : []));
    const transcript = numbered(transcriptParts(events));
    const last = turns.at(-1);
    const usages = turns.flatMap((message) => message.usage ?? []);
    const failure =
      last && FAILED.has(last.stopReason)
        ? last.errorMessage || last.stopReason
        : null;
    return {
      finalText: (last?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      toolCalls: callsOf(transcript),
      transcript,
      sessionId: events.find((e) => e.type === "session")?.id ?? null,
      tokens: sumTokens(
        usages.map((u) => ({
          input: u.input + u.cacheRead + u.cacheWrite,
          output: u.output,
        })),
      ),
      costUsd: usages.length
        ? usages.reduce((total, u) => total + (u.cost?.total ?? 0), 0)
        : null,
      loaded: NOT_REPORTED,
      error: last ? failure : "no turn_end event",
    };
  },
};

export default pi;
