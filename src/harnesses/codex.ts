import fs from "node:fs";
import path from "node:path";
import type { Harness, ToolKind } from "./shared.js";
import {
  OPENAI_ENV,
  jsonLines,
  opt,
  placeSkills,
  pluginDir,
  sumTokens,
  toolCall,
} from "./shared.js";

/** A thread item of `codex exec --json`; which fields are set depends on its type. */
interface Item {
  type: string;
  text?: string;
  command?: unknown;
  changes?: unknown;
  server?: unknown;
  tool?: unknown;
  arguments?: unknown;
  prompt?: unknown;
  query?: unknown;
}

/** The events of `codex exec --json` that the adapter reads. */
type Event =
  | { type: "item.completed"; item: Item }
  | {
      type: "turn.completed";
      usage: { input_tokens: number; output_tokens: number };
    }
  | { type: "turn.failed"; error?: { message?: string } };

// Thread items that are tool calls, mapped to the part of the item that is the call's input (never its output).
const TOOL_ITEMS: Record<string, (item: Item) => unknown> = {
  command_execution: (item) => ({ command: item.command }),
  file_change: (item) => ({ changes: item.changes }),
  mcp_tool_call: (item) => ({
    server: item.server,
    tool: item.tool,
    arguments: item.arguments,
  }),
  collab_tool_call: (item) => ({ tool: item.tool, prompt: item.prompt }),
  web_search: (item) => ({ query: item.query }),
};
const KINDS: Record<string, ToolKind> = {
  command_execution: "shell",
  file_change: "edit",
  web_search: "web",
  collab_tool_call: "subagent",
};

/**
 * Codex has no flag that loads a plugin directory for one run, so the plugin is installed into the throwaway home first.
 * @param dir - A plugin directory with a Codex marketplace file.
 * @returns The `codex` argument vectors that register the marketplace and add its first plugin.
 */
function installPlugin(dir: string): string[][] {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(dir, ".agents/plugins/marketplace.json"), "utf8"),
  ) as { name: string; plugins: [{ name: string }] };
  return [
    ["plugin", "marketplace", "add", dir],
    ["plugin", "add", `${marketplace.plugins[0].name}@${marketplace.name}`],
  ];
}

const codex: Harness = {
  id: "codex",
  bin: "codex",
  authFiles: [".codex/auth.json"],
  authEnv: OPENAI_ENV,

  invocation({ subject, home, workspace, prompt, model }) {
    const codexHome = path.join(home, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    placeSkills(subject, path.join(home, ".agents", "skills"));
    const plugin = pluginDir(subject);
    return {
      setup: plugin ? installPlugin(plugin) : [],
      args: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "-C",
        workspace,
        ...opt("-m", model),
        "--",
        prompt,
      ],
      env: { CODEX_HOME: codexHome },
    };
  },

  parse(stdout) {
    const events = jsonLines(stdout) as Event[];
    const items = events
      .filter((e) => e.type === "item.completed")
      .map((e) => e.item);
    const usages = events
      .filter((e) => e.type === "turn.completed")
      .map((e) => e.usage);
    const failed = events.find((e) => e.type === "turn.failed");
    const unfinished = usages.length ? null : "no turn.completed event";
    return {
      finalText:
        items.filter((item) => item.type === "agent_message").at(-1)?.text ??
        "",
      toolCalls: items.flatMap((item) => {
        const input = Object.hasOwn(TOOL_ITEMS, item.type)
          ? TOOL_ITEMS[item.type]
          : undefined;
        return input ? [toolCall(KINDS, item.type, input(item))] : [];
      }),
      tokens: sumTokens(
        usages.map((u) => ({ input: u.input_tokens, output: u.output_tokens })),
      ),
      costUsd: null,
      loaded: { paths: null, skills: null },
      error: failed ? failed.error?.message || "turn failed" : unfinished,
    };
  },
};

export default codex;
