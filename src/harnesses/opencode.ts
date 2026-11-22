import fs from "node:fs";
import path from "node:path";
import type { EventInput } from "../transcript.js";
import {
  callPart,
  callsOf,
  numbered,
  resultPart,
  textPart,
} from "../transcript.js";
import type { Harness, ToolKind, TurnState } from "./shared.js";
import {
  NOT_REPORTED,
  ANTHROPIC_ENV,
  OPENAI_ENV,
  jsonLines,
  opt,
  placeSkills,
  pluginDir,
  sumTokens,
  stringArg,
} from "./shared.js";
import { looksRateLimited } from "./rate-limit.js";

const KINDS: Record<string, ToolKind> = {
  bash: "shell",
  read: "read",
  write: "write",
  edit: "edit",
  patch: "edit",
  grep: "search",
  glob: "search",
  list: "search",
  webfetch: "web",
  websearch: "web",
  skill: "skill",
  task: "subagent",
};

/** The part of a `tool_use` event, which the stream writes once the tool has run. */
interface ToolPart {
  tool: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    error?: string;
    time?: { start?: number; end?: number };
  };
}

/**
 * Reads the transcript parts of a stream.
 * @param events - The events of the stream, in order.
 * @returns Text parts; for each tool, one call (a `running` and a `completed` event with the same `callID` make one when the tool is the same),
 *   and, when the state holds an output or an error, its result with the duration from its start and end times, when
 *   both are numbers. The `turn` of an event counts the `step_start` events seen so far.
 */
function transcriptParts(events: Event[]): EventInput[] {
  let turn = 0;
  const called = new Set<string>();
  return events.flatMap((e): EventInput[] => {
    if (e.type === "step_start") turn += 1;
    if (e.type === "text") {
      return e.part.text ? [textPart(e.part.text, { turn })] : [];
    }
    if (e.type !== "tool_use") return [];
    const { tool, callID: callId, state } = e.part;
    const key = `${callId ?? ""}\u0000${tool}`;
    const first = !callId || !called.has(key);
    if (callId) called.add(key);
    const call = first
      ? [callPart(KINDS, { name: tool, input: state?.input, callId }, { turn })]
      : [];
    const output = state?.output ?? state?.error;
    if (output === undefined) return call;
    const { start, end } = state?.time ?? {};
    return [
      ...call,
      resultPart(callId, output, {
        isError: state?.status === "error",
        ...(typeof start === "number" && typeof end === "number" && end >= start
          ? { durationMs: end - start }
          : {}),
      }),
    ];
  });
}

/** The events of `opencode run --format json` that the adapter reads. */
type Event = { sessionID?: string } & (
  | { type: "step_start" }
  | {
      type: "step_finish";
      part: {
        cost?: number;
        tokens: {
          input: number;
          output: number;
          cache: { read: number; write: number };
        };
      };
    }
  | { type: "text"; part: { text: string } }
  | { type: "tool_use"; part: ToolPart }
  | { type: "error"; error?: { name?: string; data?: { message?: string } } }
);

/**
 * Counts the turns of a stream as its lines arrive: one for each `step_start`, as the transcript's `turn` does.
 * @param line - One parsed line of the stream.
 * @param state - Raises `turns`.
 */
function countTurns(line: unknown, state: TurnState): void {
  const one = Object(line) as Event;
  // Only the main session counts: the session id of the first event that carries one. Another id is a subagent's.
  if (one.sessionID !== undefined) {
    if (state.seen.size === 0) state.seen.add(one.sessionID);
    else if (!state.seen.has(one.sessionID)) return;
  }
  if (one.type === "step_start") state.turns += 1;
}

// The revision of the command line this adapter builds; raise it when a change to the arguments changes what a run does.
const ARGV_REVISION = 1;

const opencode: Harness = {
  id: "opencode",
  bin: "opencode",
  // OpenCode's read tool is documented with `filePath`; no captured stream has a read call, so `path` and `file_path` are accepted too.
  pathOf: (call) => stringArg(call, ["filePath", "path", "file_path"]),
  // OpenCode's skill tool takes `name` (seen in test/fixtures/opencode.stream.jsonl).
  skillOf: (call) => stringArg(call, ["name"]),
  authFiles: [".local/share/opencode/auth.json"],
  authEnv: [...ANTHROPIC_ENV, ...OPENAI_ENV],
  capabilities: new Set([
    "subagents",
    "toolOutputs",
    "assistantText",
    "toolDurations",
    "turnGrouping",
    // The runner writes the history as a block in front of the first prompt, so every adapter has it.
    "history",
  ]),
  argvRevision: ARGV_REVISION,
  status: "scripted",
  reportsCost: true,
  isRateLimit: looksRateLimited,

  invocation({ subject, home, workspace, prompt, model }) {
    const configDir = path.join(home, ".config", "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    // V1 reads "plugin" and ignores "plugins" (seen on 1.19.6); V2 is documented to read "plugins".
    const plugin = pluginDir(subject);
    const plugins = plugin ? [plugin] : [];
    fs.writeFileSync(
      path.join(configDir, "opencode.json"),
      JSON.stringify({ plugin: plugins, plugins }),
    );
    const placed = placeSkills(subject, path.join(home, ".agents", "skills"));
    return {
      placed,
      args: [
        "run",
        "--format",
        "json",
        "--auto",
        "--dir",
        workspace,
        ...opt("-m", model),
        "--",
        prompt,
      ],
      env: {},
    };
  },

  countTurns,

  parse(stdout) {
    const events = jsonLines(stdout) as Event[];
    const steps = events
      .filter((e) => e.type === "step_finish")
      .map((e) => e.part);
    const failure = events.find((e) => e.type === "error")?.error;
    const unfinished = steps.length ? null : "no step_finish event";
    const transcript = numbered(transcriptParts(events));
    return {
      finalText: events
        .slice(events.map((e) => e.type).lastIndexOf("step_start") + 1)
        .filter((e) => e.type === "text")
        .map((e) => e.part.text)
        .join(""),
      toolCalls: callsOf(transcript),
      transcript,
      sessionId: events.find((e) => e.sessionID)?.sessionID ?? null,
      tokens: sumTokens(
        steps.map(({ tokens }) => ({
          input: tokens.input + tokens.cache.read + tokens.cache.write,
          output: tokens.output,
        })),
      ),
      costUsd: steps.length
        ? steps.reduce((total, step) => total + (step.cost ?? 0), 0)
        : null,
      loaded: NOT_REPORTED,
      error: failure
        ? failure.data?.message || failure.name || "error"
        : unfinished,
      unfinished: !failure && steps.length === 0,
    };
  },
};

export default opencode;
