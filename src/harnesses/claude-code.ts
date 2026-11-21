import path from "node:path";
import type { Harness, ToolKind } from "./shared.js";
import {
  ANTHROPIC_ENV,
  jsonLines,
  opt,
  placeSkills,
  pluginDir,
  toolCall,
} from "./shared.js";

const KINDS: Record<string, ToolKind> = {
  Bash: "shell",
  Read: "read",
  Write: "write",
  Edit: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  WebFetch: "web",
  WebSearch: "web",
  Skill: "skill",
  Agent: "subagent",
  Task: "subagent",
};

/** The events of `--output-format stream-json` that the adapter reads. */
type Event =
  | {
      type: "system";
      subtype: string;
      plugins?: { path: string }[];
      skills?: string[];
    }
  | {
      type: "assistant";
      message?: { content?: { type: string; name: string; input: unknown }[] };
    }
  | {
      type: "result";
      subtype: string;
      result?: string;
      is_error?: boolean;
      total_cost_usd?: number;
      usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };

const claudeCode: Harness = {
  id: "claude-code",
  bin: "claude",
  authFiles: [".claude/.credentials.json"],
  authEnv: ANTHROPIC_ENV,

  invocation({ subject, home, prompt, model, maxTurns }) {
    const configDir = path.join(home, ".claude");
    placeSkills(subject, path.join(configDir, "skills"));
    return {
      // Never --bare: it switches off the hooks a plugin ships.
      args: [
        "-p",
        ...opt("--plugin-dir", pluginDir(subject)),
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        ...opt("--model", model),
        ...opt("--max-turns", maxTurns),
        "--",
        prompt,
      ],
      env: { CLAUDE_CONFIG_DIR: configDir },
    };
  },

  parse(stdout) {
    const events = jsonLines(stdout) as Event[];
    const init = events
      .filter((e) => e.type === "system")
      .find((e) => e.subtype === "init");
    const result = events.filter((e) => e.type === "result").at(-1);
    const usage = result?.usage;
    const failure = result?.is_error ? result.result || result.subtype : null;
    return {
      finalText: result?.result ?? "",
      toolCalls: events
        .filter((e) => e.type === "assistant")
        .flatMap((e) => e.message?.content ?? [])
        .filter((block) => block.type === "tool_use")
        .map(({ name, input }) => toolCall(KINDS, name, input)),
      tokens: usage
        ? {
            input:
              usage.input_tokens +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0),
            output: usage.output_tokens,
          }
        : null,
      costUsd: result?.total_cost_usd ?? null,
      loaded: {
        paths: init?.plugins ? init.plugins.map((plugin) => plugin.path) : null,
        // A plugin's skill is listed as `plugin:skill`.
        skills: init?.skills ? init.skills.map(lastSegment) : null,
      },
      error: result ? failure : "no result event",
    };
  },
};

/**
 * Drops the plugin prefix of a skill name.
 * @param name - A skill as Claude Code lists it, `skill` or `plugin:skill`.
 * @returns The part after the last colon.
 */
function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

export default claudeCode;
