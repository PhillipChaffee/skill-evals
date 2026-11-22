import fs from "node:fs";
import path from "node:path";
import { awaitedCalls } from "../question.js";
import { callsOf, numbered } from "../transcript.js";
import type { MessageEvent } from "./claude-code-stream.js";
import {
  agentTokens,
  countTurns,
  transcriptParts,
} from "./claude-code-stream.js";
import type {
  Harness,
  Loaded,
  LoadedSubject,
  ToolKind,
  TranscriptEvent,
} from "./shared.js";
import {
  ANTHROPIC_ENV,
  foreignPaths,
  jsonLines,
  opt,
  placeSkills,
  pluginDir,
  samePath,
  stringArg,
} from "./shared.js";
import { MCP_CONFIG, writeMcpConfig } from "./claude-code-mcp.js";
import { stripClaudeCode } from "./claude-code-strip.js";
import { looksRateLimited } from "./rate-limit.js";
import { placeRules } from "./rules.js";
import type { RulesFile, RulesTarget } from "./rules.js";

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
  // Confirmed from the CLI binary's strings: the tool is named `AskUserQuestion`, and its input holds `questions`.
  AskUserQuestion: "question",
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
  | { type: "assistant" | "user" }
  | {
      type: "result";
      session_id?: string;
      subtype: string;
      result?: string;
      is_error?: boolean;
      total_cost_usd?: number;
      /** The tool calls that a `-p` process could not carry out; an `AskUserQuestion` among them is the agent asking. */
      permission_denials?: { tool_name?: string; tool_use_id?: string }[];
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
  env: {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    // Both are read by the compiled CLI: the first skips the managed policy skills directory, the second the sync of
    // organization memory.
    CLAUDE_CODE_DISABLE_POLICY_SKILLS: "1",
    CLAUDE_CODE_DISABLE_ORG_MEMORY: "1",
  },
  proves:
    "Every plugin directory, plugin-prefixed skill and agent, and MCP server in the init event is the subject's. The report must list plugins and skills, or the run is invalid.",
  notProven:
    "Managed policy settings (hooks, environment, permissions), a managed CLAUDE.md file, rules and hooks, and the organization's managed agents, which the init event does not tell from built-in agents.",
  notes: [
    "- `--setting-sources user`: the CLI loads `CLAUDE_CONFIG_DIR/skills`, the user's settings and the user's plugins only for the `user` source, and the workspace's `.claude/` skills and settings only for `project` and `local`. User level is the throwaway home plus anything the account syncs into it: the run puts only its own skills there, and a skills subject needs the `user` source to load. An empty list (`\"\"`) is accepted by the parser, but it would leave a skills subject unloaded.",
    "- Skills and plugins that a claude.ai login syncs into the home are loaded under the `user` source, and no switch turns that off. They are detected from the files they leave: every skill directory under `<config dir>/skills` and `<config dir>/synced` that the run did not place is outside the subject (`account skill <name>`), and a synced plugin is a reported plugin path that is not the subject's copy. The exact location of the synced root was read from a minified binary and is searched under both roots.",
    "- `--model`: the `user` source also lets the organization's default model apply when `--model` is not given. Pass `--model` in CI.",
    "- `--strict-mcp-config`: only the servers of `--mcp-config`. The CLI has a check that refuses it with the message \"You cannot use --strict-mcp-config when an enterprise MCP config is present\". Where it exits the process was not confirmed, so the foreign-server rule covers the case where the run starts anyway. A plugin's own MCP server is named `plugin:<plugin>:<server>` in the init event; every other server is outside the subject. Whether the flag also drops a plugin's own servers was not confirmed.",
    "- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CODE_DISABLE_POLICY_SKILLS=1` and `CLAUDE_CODE_DISABLE_ORG_MEMORY=1` switch off auto memory, the organization's managed policy skills, and the sync of organization memory. All three names are read by the compiled CLI.",
    "- Never `--bare`: it also switches off the subject plugin's own hooks.",
    "- A bare skill name that is not one of the subject's own counts as a Claude Code built-in, which is not outside the subject. Policy skills are switched off, so no managed skill appears as one. The built-in names were not confirmed against a real capture. A bare agent name is not judged, because the init event does not tell a built-in agent from a managed one. A plugin directory, a `plugin:`-prefixed skill or agent of another plugin, and an MCP server that is not the subject's are outside the subject.",
    "- Organization-managed plugins load under every flag. The init event lists them, so the run is invalid.",
    "- Not proven by the record: managed policy settings (hooks, environment, permissions), a managed `CLAUDE.md` file, rules, hooks, and managed agents. The report does not list them.",
  ].join("\n"),
};

/**
 * Tells whether the harness refused the question call that the run ended on.
 * @param denials - The result's `permission_denials`.
 * @param transcript - The run's events.
 * @returns True when a denied `AskUserQuestion` has the id of a question call that is among the main agent's last events,
 *   with nothing after it but its result.
 */
function stoppedOn(
  denials: { tool_name?: string; tool_use_id?: string }[] | undefined,
  transcript: TranscriptEvent[],
): boolean {
  const awaited = awaitedCalls(transcript).map((event) => event.callId);
  return (denials ?? []).some(
    (denied) =>
      denied.tool_name === "AskUserQuestion" &&
      awaited.includes(denied.tool_use_id),
  );
}

/**
 * Says where Claude Code reads a subject's rules: the rules directory goes to `<config dir>/rules`, in the run's home,
 * and the instruction file is its user memory file, `<config dir>/CLAUDE.md`. The home is where a run's `user` setting
 * source lives, so the rules load with and without `--isolated`, and the workspace holds no extra file.
 * @param files - The rule files and the instruction file.
 * @returns One place for each file.
 */
function rulesTargets(files: RulesFile[]): RulesTarget[] {
  return files.map((file) =>
    file.role === "instruction"
      ? { root: "home", path: ".claude/CLAUDE.md" }
      : {
          root: "home",
          path: `.claude/rules/${file.relative}`,
          area: ".claude/rules",
        },
  );
}

// The revision of the command line this adapter builds: 2 added `--include-hook-events`.
const ARGV_REVISION = 2;

const claudeCode: Harness = {
  id: "claude-code",
  bin: "claude",
  // Claude Code's Read tool takes `file_path` (seen in test/fixtures/claude-code-tools.stream.jsonl).
  pathOf: (call) => stringArg(call, ["file_path"]),
  // Claude Code's Skill tool takes `skill`, as `plugin:skill` for a plugin's skill.
  skillOf: (call) => stringArg(call, ["skill"]),
  authFiles: [".claude/.credentials.json"],
  authEnv: ANTHROPIC_ENV,
  capabilities: new Set([
    "subagents",
    "turnGrouping",
    "childCalls",
    "childText",
    "loadedReport",
    "skillListing",
    "isolated",
    "toolOutputs",
    "assistantText",
    // The runner writes the history as a block in front of the first prompt, so every adapter has it.
    "history",
    // Confirmed from the CLI binary's strings, not from a stream: `AskUserQuestion` is the question tool.
    "askUser",
    // Confirmed from `claude --help` (2.1.330): `-r, --resume [value]` "Resume a conversation by session ID or name"
    // continues a session in a new `-p` process, and a `-p` process without it starts a new conversation.
    "multiTurn",
    "resume",
    "clear",
    // Confirmed from the CLI binary (2.1.330), not from a run: `claude --help` has `--include-hook-events` ("Include all
    // hook lifecycle events in the output stream", stream-json only), and the binary's stream schema has the system
    // events `hook_started`, `hook_progress` and `hook_response` (`hook_event`, `stdout`, `exit_code`, `outcome`).
    "hooks",
    // Confirmed from the binary's strings, not from a run: the user's rules directory is `<config dir>/rules` and the
    // user memory file is `<config dir>/CLAUDE.md`, both read under the `user` setting source, which `--isolated`
    // keeps. The project's `.claude/rules` is read only under the `project` source, which `--isolated` turns off. The
    // stream reports no loaded rule, so `reportedLoaded` is always null for this adapter.
    "rules",
    // Confirmed from `claude --help` (2.1.330) and the binary's strings, not from a real run: `--mcp-config <configs...>`
    // "Load MCP servers from JSON files or strings", whose file is `{ "mcpServers": { <name>: { command, args, env } } }`,
    // and a tool of a server is named `mcp__<server>__<tool>`, which the parser maps to the kind `mcp`
    // (`docs/design/mcp-mocks.md`). Task 29 confirms it with a real model.
    "mcp",
    // Not declared: `userInvoke`. `claude --help` says "Skills still resolve via /skill-name" (`--bare`), but whether a
    // `/skill args` prompt in a `-p` process loads the skill is unconfirmed without a real model; Task 29 confirms it.
    // Not declared: `historyNative` and `sessionStore`. `claude-code-history.ts` writes a session as the binary's strings
    // show it, and `--resume` would continue it, but whether Claude Code accepts a planted session needs a real model;
    // Task 29 confirms it. Tests use a test-only harness that declares both (`docs/design/multi-turn-and-history.md`).
    // Not declared: `compact`. `claude --help` shows only `--autocompact` (the automatic window), no way to ask for a
    // compaction in a `-p` process. The stream's `compact_boundary` event is parsed, so a harness that reports one shows it.
  ]),
  argvRevision: ARGV_REVISION,
  status: "real-model",
  reportsCost: true,
  isRateLimit: looksRateLimited,

  invocation({
    subject,
    home,
    prompt,
    model,
    maxTurns,
    isolated,
    session,
    mcpDir,
  }) {
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
        "--include-hook-events",
        "--permission-mode",
        "bypassPermissions",
        ...opt("--model", model),
        ...opt("--max-turns", maxTurns),
        ...opt("--resume", session),
        // `--mcp-config` takes a list, so it comes before another flag and never last before `--`.
        ...(mcpDir ? ["--mcp-config", path.join(mcpDir, MCP_CONFIG)] : []),
        "--",
        prompt,
      ],
      env: { CLAUDE_CONFIG_DIR: configDir, ...(isolated && ISOLATION.env) },
    };
  },

  registerMcp: writeMcpConfig,

  rulesTargets,
  installRules: (files, input) => placeRules(files, rulesTargets(files), input),
  strip: stripClaudeCode,

  countTurns,

  parse(stdout) {
    const raw = jsonLines(stdout);
    const events = raw as Event[];
    const transcript = numbered(transcriptParts(raw as MessageEvent[], KINDS));
    const init = events
      .filter((e) => e.type === "system")
      .find((e) => e.subtype === "init");
    const result = events.filter((e) => e.type === "result").at(-1);
    const usage = result?.usage;
    // The CLI's own turn limit is a stop the case asked for, not a failure.
    const hitMaxTurns = result?.subtype === "error_max_turns";
    const failure =
      result?.is_error && !hitMaxTurns ? result.result || result.subtype : null;
    return {
      // An error result's text is the error, never an answer.
      finalText: result?.is_error && !hitMaxTurns ? "" : (result?.result ?? ""),
      toolCalls: callsOf(transcript),
      transcript,
      sessionId:
        (raw as MessageEvent[]).find((e) => e.session_id)?.session_id ?? null,
      tokens: usage
        ? {
            input:
              usage.input_tokens +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0),
            output: usage.output_tokens,
          }
        : null,
      agentTokens: agentTokens(raw as MessageEvent[]),
      // Unconfirmed against a real run: a `-p` process refuses the question tool, and its result lists the refusal as
      // `{ tool_name, tool_use_id, tool_input }`. Only a refusal of the question that the run ended on counts: the agent
      // goes on after a refused question, and a subagent's question is not the user's to answer for this run.
      askedUser: result
        ? stoppedOn(result.permission_denials, transcript)
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
      unfinished: !result,
      hitMaxTurns,
    };
  },

  // A bare skill name is a built-in, because policy skills are switched off; a bare agent name may also be managed.
  foreign: foreignOfClaude,
  strays: strayskills,
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

const SKILL_FILE = /^skill\.md$/i;

/**
 * Finds the skill directories under a root, without going into one that was placed.
 * @param root - A directory that may not exist.
 * @param placed - The directories the run placed, as resolved paths.
 * @returns The directories that hold a SKILL.md and are not placed.
 */
function skillDirs(root: string, placed: Set<string>): string[] {
  if (placed.has(path.resolve(root)) || !fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && SKILL_FILE.test(e.name))) return [root];
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => skillDirs(path.join(root, entry.name), placed));
}

/**
 * Names the skills that an account synced into the run's config directory, which the init event lists as bare names.
 * @param run - The run's home, and the skill directories it placed.
 * @param run.home - The throwaway home.
 * @param run.placed - Skill name to the directory the adapter placed.
 * @returns `account skill <name>` for every skill directory under the skills and synced roots that is not placed.
 */
function strayskills(run: {
  home: string;
  placed: Record<string, string> | undefined;
}): string[] {
  const config = path.join(run.home, ".claude");
  const placed = new Set(
    Object.values(run.placed ?? {}).map((d) => path.resolve(d)),
  );
  return ["skills", "synced"]
    .flatMap((root) => skillDirs(path.join(config, root), placed))
    .map((dir) => `account skill ${path.basename(dir)}`);
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
