import path from "node:path";
import type { Harness, ToolKind } from "./shared.js";
import {
  NOT_REPORTED,
  ANTHROPIC_ENV,
  OPENAI_ENV,
  jsonLines,
  opt,
  placeSkills,
  pluginDir,
  sumTokens,
  toolCall,
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
  | { type: "turn_end"; message?: Message }
  | { type: "tool_execution_start"; toolName: string; args: unknown };

const pi: Harness = {
  id: "pi",
  bin: "pi",
  authFiles: [".pi/agent/auth.json", ".pi/agent/models.json"],
  authEnv: [...ANTHROPIC_ENV, ...OPENAI_ENV],
  capabilities: new Set([]),
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
      toolCalls: events
        .filter((e) => e.type === "tool_execution_start")
        .map((e) => toolCall(KINDS, e.toolName, e.args)),
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
