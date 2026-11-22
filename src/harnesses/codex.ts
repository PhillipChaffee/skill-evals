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
import type { Harness, RunInput, ToolKind } from "./shared.js";
import {
  NOT_REPORTED,
  OPENAI_ENV,
  jsonLines,
  opt,
  placeSkills,
  pluginDir,
  sumTokens,
} from "./shared.js";
import { looksRateLimited } from "./rate-limit.js";

/** A thread item of `codex exec --json`; which fields are set depends on its type. */
interface Item {
  type: string;
  id?: string;
  text?: string;
  command?: unknown;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  result?: { content?: unknown } | null;
  error?: { message?: string } | null;
  changes?: unknown;
  server?: unknown;
  tool?: unknown;
  arguments?: unknown;
  prompt?: unknown;
  query?: unknown;
}

/** The events of `codex exec --json` that the adapter reads. */
type Event =
  | { type: "thread.started"; thread_id?: string }
  | { type: "item.started"; item: Item }
  | { type: "item.completed"; item: Item }
  | {
      type: "turn.completed";
      usage: { input_tokens: number; output_tokens: number };
    }
  | { type: "turn.failed"; error?: { message?: string } };

// Thread items that are tool calls, mapped to the part of the item that is the call's input (never its output).
const COMMAND = "command_execution";
const MESSAGE = "agent_message";
const TOOL_ITEMS: Record<string, (item: Item) => unknown> = {
  [COMMAND]: (item) => ({ command: item.command }),
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
  [COMMAND]: "shell",
  file_change: "edit",
  web_search: "web",
  collab_tool_call: "subagent",
};

/**
 * Reads what a tool item reports back.
 * @param item - A completed thread item that is a tool call.
 * @returns Its output and whether it failed; null when the item carries no result. A command's result is its
 *   aggregated output. An MCP call's is its `result.content`, or its `error.message`. No other item type has one, so
 *   none is made up for them. An item fails when its status is `failed`, it has an `error`, or its exit code is not 0.
 */
function resultOf(item: Item): { output: unknown; isError: boolean } | null {
  const output =
    item.type === COMMAND
      ? item.aggregated_output
      : item.type === "mcp_tool_call"
        ? (item.error?.message ?? item.result?.content ?? item.result)
        : undefined;
  if (output === undefined || output === null) return null;
  const exit = item.exit_code ?? 0;
  const isError = item.status === "failed" || Boolean(item.error) || exit !== 0;
  return { output, isError };
}

/**
 * Reads the transcript parts of a stream's items.
 * @param events - The events of the stream, in order.
 * @returns A tool item is a call where it started, or where it completed when no start was seen, and a result only
 *   where the completed item carries one, so a command that started and never completed is a call with no result. An
 *   `agent_message` is text.
 */
function itemParts(events: Event[]): EventInput[] {
  const called = new Set<string>();
  return events.flatMap((e): EventInput[] => {
    if (!("item" in e)) return [];
    const { item } = e;
    const done = e.type === "item.completed";
    if (done && item.type === MESSAGE) {
      return item.text ? [textPart(item.text)] : [];
    }
    const input = Object.hasOwn(TOOL_ITEMS, item.type)
      ? TOOL_ITEMS[item.type]
      : undefined;
    // A start without an id could never be matched to its completion, so only the completion counts.
    if (!input || (!done && !item.id)) return [];
    const { id: callId } = item;
    const first = !callId || !called.has(callId);
    if (callId) called.add(callId);
    const answer = done ? resultOf(item) : null;
    return [
      ...(first
        ? [callPart(KINDS, { name: item.type, input: input(item), callId })]
        : []),
      ...(answer
        ? [
            resultPart(callId, answer.output as string, {
              isError: answer.isError,
            }),
          ]
        : []),
    ];
  });
}

/**
 * Reads the marketplace file of a Codex plugin directory.
 * @param dir - A plugin directory with a Codex marketplace file.
 * @returns The marketplace's name and the name of its first plugin.
 */
function marketplaceOf(dir: string): { market: string; plugin: string } {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(dir, ".agents/plugins/marketplace.json"), "utf8"),
  ) as { name: string; plugins: [{ name: string }] };
  return { market: marketplace.name, plugin: marketplace.plugins[0].name };
}

/**
 * Codex has no flag that loads a plugin directory for one run, so the plugin is installed into the throwaway home first.
 * @param dir - A plugin directory with a Codex marketplace file.
 * @returns The `codex` argument vectors that register the marketplace and add its first plugin.
 */
function installPlugin(dir: string): string[][] {
  const { market, plugin } = marketplaceOf(dir);
  return [
    ["plugin", "marketplace", "add", dir],
    ["plugin", "add", `${plugin}@${market}`],
  ];
}

/**
 * Finds the skill directories of the plugin that `installPlugin` put in Codex's plugin cache, which is where the agent
 * reads the plugin's skills: `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>`.
 * @param input - The run's input.
 * @returns Skill name to its directory in the cache; the newest version in name order wins. A plugin that is not
 *   there, or a subject with no plugin, gives none.
 */
function installedSkills(input: RunInput): Record<string, string> {
  const dir = pluginDir(input.subject);
  if (!dir) return {};
  try {
    const { market, plugin } = marketplaceOf(dir);
    const base = path.join(input.home, ".codex/plugins/cache", market, plugin);
    return Object.fromEntries(
      fs
        .readdirSync(base)
        .sort()
        .flatMap((version) =>
          fs
            .readdirSync(path.join(base, version, "skills"), {
              withFileTypes: true,
            })
            .filter((entry) => entry.isDirectory())
            .map((entry) => [
              entry.name,
              path.join(base, version, "skills", entry.name),
            ]),
        ),
    );
  } catch {
    return {};
  }
}

const codex: Harness = {
  id: "codex",
  bin: "codex",
  // Codex has no read kind: it reads files through shell commands, which `shell_read` covers.
  pathOf: () => null,
  placedAfterSetup: installedSkills,
  authFiles: [".codex/auth.json"],
  authEnv: OPENAI_ENV,
  capabilities: new Set(["subagents", "toolOutputs", "assistantText"]),
  status: "scripted",
  reportsCost: false,
  isRateLimit: looksRateLimited,

  invocation({ subject, home, workspace, prompt, model }) {
    const codexHome = path.join(home, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    const placed = placeSkills(subject, path.join(home, ".agents", "skills"));
    const plugin = pluginDir(subject);
    return {
      placed,
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
    const transcript = numbered(itemParts(events));
    const unfinished = usages.length ? null : "no turn.completed event";
    return {
      finalText:
        items.filter((item) => item.type === MESSAGE).at(-1)?.text ?? "",
      toolCalls: callsOf(transcript),
      transcript,
      sessionId:
        events.find((e) => e.type === "thread.started")?.thread_id ?? null,
      tokens: sumTokens(
        usages.map((u) => ({ input: u.input_tokens, output: u.output_tokens })),
      ),
      costUsd: null,
      loaded: NOT_REPORTED,
      error: failed ? failed.error?.message || "turn failed" : unfinished,
      unfinished: !failed && usages.length === 0,
    };
  },
};

export default codex;
