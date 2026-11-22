import fs from "node:fs";
import path from "node:path";
import type { Harness, Parsed } from "../harnesses/shared.js";
import { messageOf, tempDir } from "../scope.js";
import { mergeMockLog } from "./merge.js";
import type { McpCall, McpServerEntry, McpSource } from "./types.js";

/** The name of the log file inside a run's mock directory. */
const LOG_NAME = "calls.log";

/** A run's mock servers, copied out of the case. */
export interface StagedMcp {
  /** The run's own temporary directory, outside the workspace and the home. */
  dir: string;
  /** The file every server appends its calls to; only the servers' environment names it. */
  log: string;
  /** The servers, ready for `Harness.registerMcp`. */
  servers: McpServerEntry[];
  /** Removes the directory. */
  dispose: () => void;
}

/**
 * Copies the mock server's script into the run's directory under a neutral name, so that the command the agent can read
 * names neither this package nor its sources. The script imports nothing of the package at run time.
 * @param dir - The run's mock directory.
 * @returns The executable and its leading arguments; the server's name and directory follow.
 */
function stageCommand(dir: string): { command: string; args: string[] } {
  // `.mts` and `.mjs` are always ES modules, wherever the copy lies.
  const ext = path.extname(import.meta.filename) === ".ts" ? ".mts" : ".mjs";
  const script = path.join(dir, `server${ext}`);
  const original = path.extname(import.meta.filename);
  fs.copyFileSync(
    path.join(import.meta.dirname, `mock-server${original}`),
    script,
  );
  return { command: process.execPath, args: [script] };
}

/**
 * Copies a case's mock servers into a directory of the run's own, and builds the commands that start them. Nothing the
 * agent can see names the case's directory: the servers read the copy.
 * @param source - The case's `mcp/` directory and the servers in it.
 * @returns The staged servers.
 */
export function stageMcp(source: McpSource): StagedMcp {
  const temp = tempDir("svc-");
  const log = path.join(temp.dir, LOG_NAME);
  const { command, args } = stageCommand(temp.dir);
  const servers = source.servers.map((name): McpServerEntry => {
    const copy = path.join(temp.dir, "servers", name);
    fs.cpSync(path.join(source.dir, name), copy, { recursive: true });
    return {
      name,
      command,
      args: [...args, name, copy],
      env: { MOCK_LOG: log },
    };
  });
  return { dir: temp.dir, log, servers, dispose: temp.dispose };
}

/**
 * Reads what the mock servers logged.
 * @param log - The log file's path.
 * @returns The text of the file, empty when no server wrote one.
 */
export function readLogText(log: string): string {
  try {
    return fs.readFileSync(log, "utf8");
  } catch {
    return "";
  }
}

/**
 * Parses the mock log.
 * @param text - The log's text, one JSON object per line.
 * @returns The calls, ordered by time. A line that is not whole, such as a last line cut off, is skipped.
 */
export function parseLog(text: string): McpCall[] {
  return text
    .split("\n")
    .flatMap((line): McpCall[] => {
      try {
        return line === "" ? [] : [JSON.parse(line) as McpCall];
      } catch {
        return [];
      }
    })
    .sort((x, y) => x.at.localeCompare(y.at));
}

/** What starting a run's mock servers came to. */
export interface McpStarted {
  /** The staged servers; null when the harness cannot register them. */
  staged: StagedMcp;
  /** Why the run cannot start, which makes it invalid; null when the servers are registered. */
  failure: string | null;
}

/**
 * Stages a run's mock servers and tells the harness about them.
 * @param harness - The adapter; one without `registerMcp` cannot run a case that has mock servers.
 * @param source - The case's mock servers.
 * @param dirs - The run's home and workspace, which the adapter may read.
 * @param dirs.home - The throwaway home.
 * @param dirs.workspace - The directory the agent works in.
 * @returns The staged servers, which the caller disposes, and why registering failed, if it did.
 */
export function startMcp(
  harness: Pick<Harness, "id" | "registerMcp">,
  source: McpSource,
  dirs: { home: string; workspace: string },
): McpStarted {
  const staged = stageMcp(source);
  if (harness.registerMcp === undefined) {
    return {
      staged,
      failure: `${harness.id} cannot register MCP servers`,
    };
  }
  try {
    harness.registerMcp(staged.servers, { dir: staged.dir, ...dirs });
    return { staged, failure: null };
  } catch (error) {
    return {
      staged,
      failure: `could not register the MCP servers for ${harness.id}: ${messageOf(error)}`,
    };
  }
}

/**
 * Counts calls by `<server>.<tool>`.
 * @param names - One name for each call.
 * @returns Name to the number of calls.
 */
function tally(names: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

/**
 * Compares the calls the stream shows with the calls the mock servers logged.
 * @param parsed - What the adapter read from the stream.
 * @param calls - What the mock servers logged.
 * @param servers - The names of the registered mock servers; the stream's calls to any other server are not compared.
 * @returns One line for each `<server>.<tool>` whose count differs, or one `the mock log and the stream disagree: ...`
 *   line that lists them; empty when they agree. A line in the log that no call of the stream explains is a forged
 *   one, or a call the stream lost; either way the run cannot be trusted.
 */
function disagreement(
  parsed: Parsed,
  calls: McpCall[],
  servers: string[],
): string[] {
  const own = (name: string): boolean =>
    servers.some((server) => name.startsWith(`${server}.`));
  const seen = tally(
    parsed.toolCalls.flatMap((call) =>
      call.kind === "mcp" && own(call.name) ? [call.name] : [],
    ),
  );
  const logged = tally(calls.map((call) => `${call.server}.${call.tool}`));
  const names = [...new Set([...seen.keys(), ...logged.keys()])].sort();
  const differing = names
    .filter((name) => (seen.get(name) ?? 0) !== (logged.get(name) ?? 0))
    .map(
      (name) =>
        `${name}: the stream shows ${String(seen.get(name) ?? 0)}, the log ${String(logged.get(name) ?? 0)}`,
    );
  return differing.length === 0
    ? []
    : [`the mock log and the stream disagree: ${differing.join("; ")}`];
}

/** What reading the mock log after a run came to. */
export interface MockLogRead {
  /** What the adapter read, with the logged calls merged in for an adapter whose stream cannot show them. */
  parsed: Parsed;
  /** The log's text; null for a case with no servers. */
  mcpLog: string | null;
  /** Why the run cannot be trusted, which makes it invalid; empty when the log and the stream agree. */
  mcpProblems: string[];
}

/**
 * Reads the mock log after the run. For an adapter whose stream shows MCP calls the log is only a cross-check: the
 * stream is never changed, and a log that does not match it, with extra, missing or forged lines, is a problem. For an
 * adapter whose `mcpCalls` is `log` the logged calls are merged into the transcript.
 * @param harness - The adapter.
 * @param parsed - What the adapter read from the stream.
 * @param started - The run's mock servers; null for a case with none.
 * @returns The log's text, the stream (merged or not), and the problems.
 */
export function withMockLog(
  harness: Pick<Harness, "capabilities" | "mcpCalls">,
  parsed: Parsed,
  started: McpStarted | null,
): MockLogRead {
  if (started === null) return { parsed, mcpLog: null, mcpProblems: [] };
  const mcpLog = readLogText(started.staged.log);
  const calls = parseLog(mcpLog);
  if (!harness.capabilities.has("mcp")) {
    return { parsed, mcpLog, mcpProblems: [] };
  }
  if (harness.mcpCalls === "log") {
    return { parsed: mergeMockLog(parsed, calls), mcpLog, mcpProblems: [] };
  }
  const servers = started.staged.servers.map((server) => server.name);
  return { parsed, mcpLog, mcpProblems: disagreement(parsed, calls, servers) };
}
