import path from "node:path";
import type { Harness, Loaded, LoadedSubject, ToolKind } from "./shared.js";
import {
  ANTHROPIC_ENV,
  foreignPaths,
  jsonLines,
  opt,
  placeSkills,
  pluginDir,
  samePath,
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
      plugins?: { name: string; path: string }[];
      skills?: string[];
      agents?: string[];
      mcp_servers?: { name: string }[];
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

// Never --bare: it switches off the hooks a plugin ships.
// `user` is the throwaway home, which holds only what the run seeds, and it is the one source that loads
// CLAUDE_CONFIG_DIR/skills, where a skills subject is placed. Project and local stay off, so the workspace's own
// `.claude/` is not read.
const ISOLATION: NonNullable<Harness["isolation"]> = {
  args: ["--setting-sources", "user", "--strict-mcp-config"],
  env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
  proves:
    "Every plugin directory, plugin-prefixed skill and agent, and MCP server in the init event is the subject's. The report must list plugins and skills, or the run is invalid.",
  notProven:
    "Managed policy settings (hooks, environment, permissions), managed memory and CLAUDE.md files, rules and hooks, and bare-named skills and agents, which are Claude Code's built-ins or the organization's managed ones: no switch removes them and the init event does not tell them apart.",
};

const claudeCode: Harness = {
  id: "claude-code",
  bin: "claude",
  authFiles: [".claude/.credentials.json"],
  authEnv: ANTHROPIC_ENV,
  capabilities: new Set([
    "subagents",
    "childCalls",
    "loadedReport",
    "skillListing",
    "isolated",
  ]),
  status: "real-model",

  invocation({ subject, home, prompt, model, maxTurns, isolated }) {
    const configDir = path.join(home, ".claude");
    const placed = placeSkills(subject, path.join(configDir, "skills"));
    return {
      placed,
      args: [
        "-p",
        ...opt("--plugin-dir", pluginDir(subject)),
        ...(isolated ? ISOLATION.args : []),
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
      env: { CLAUDE_CONFIG_DIR: configDir, ...(isolated && ISOLATION.env) },
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
        rawSkills: init?.skills ?? null,
        plugins: init?.plugins
          ? init.plugins.map(({ name, path: dir }) => ({ name, path: dir }))
          : null,
        agents: init?.agents ?? null,
        rules: null,
        hooks: null,
        mcpServers: init?.mcp_servers
          ? init.mcp_servers.map((server) => server.name)
          : null,
      },
      error: result ? failure : "no result event",
    };
  },

  // A bare skill or agent name is a built-in or a managed-policy one, which no switch removes; see `isolation`.
  foreign: foreignOfClaude,
  isolation: ISOLATION,
};

/**
 * Names what Claude Code loaded that is not the subject's.
 * @param loaded - What the init event reported.
 * @param subject - What the run loaded.
 * @returns The plugin paths other than the subject's copy, and the skills of any plugin but the subject's.
 */
function foreignOfClaude(
  loaded: Loaded,
  subject: LoadedSubject | null,
): string[] {
  const own = (loaded.plugins ?? [])
    .filter(
      (plugin) =>
        subject?.kind === "plugin" && samePath(plugin.path, subject.dir),
    )
    .map((plugin) => plugin.name);
  // `plugin:name` and `plugin:skill` carry the plugin's name before the last colon.
  const ofOther = (name: string): boolean => {
    const colon = name.lastIndexOf(":");
    return colon >= 0 && !own.includes(name.slice(0, colon));
  };
  // A plugin's MCP server is `plugin:<plugin>:<server>`; every other server comes from somewhere else.
  const serverIsOwn = (name: string): boolean =>
    own.some((plugin) => name.startsWith(`plugin:${plugin}:`));
  return [
    ...foreignPaths(loaded, subject),
    ...(loaded.rawSkills ?? []).filter(ofOther).map((n) => `skill ${n}`),
    ...(loaded.agents ?? []).filter(ofOther).map((n) => `agent ${n}`),
    ...(loaded.mcpServers ?? [])
      .filter((name) => !serverIsOwn(name))
      .map((n) => `MCP server ${n}`),
  ];
}

/**
 * Drops the plugin prefix of a skill name.
 * @param name - A skill as Claude Code lists it, `skill` or `plugin:skill`.
 * @returns The part after the last colon.
 */
function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

export default claudeCode;
