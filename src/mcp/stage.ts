import fs from "node:fs";
import path from "node:path";
import type { Harness, Parsed } from "../harnesses/shared.js";
import { messageOf, tempDir } from "../scope.js";
import { mergeMockLog } from "./merge.js";
import type { McpCall, McpServerEntry, McpSource } from "./types.js";

/** The name of the log file inside a run's mock directory. */
const LOG_NAME = "mock.log";

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
 * Names the command that starts a mock server: this package's `mock-server` file, which is `.ts` when the sources run
 * and `.js` in the compiled package. The script is the same file as the `skill-evals-mcp-mock` binary.
 * @returns The executable and its leading arguments; the server's name and directory follow.
 */
function mockCommand(): { command: string; args: string[] } {
  const ext = path.extname(import.meta.filename);
  return {
    command: process.execPath,
    args: [path.join(import.meta.dirname, `mock-server${ext}`)],
  };
}

/**
 * Copies a case's mock servers into a directory of the run's own, and builds the commands that start them. Nothing the
 * agent can see names the case's directory: the servers read the copy.
 * @param source - The case's `mcp/` directory and the servers in it.
 * @returns The staged servers.
 */
export function stageMcp(source: McpSource): StagedMcp {
  const temp = tempDir("mcp-");
  const log = path.join(temp.dir, LOG_NAME);
  const { command, args } = mockCommand();
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
 * Reads the mock log after the run and adds what the stream lacks.
 * @param harness - The adapter; only one with the `mcp` capability has the log merged into its transcript.
 * @param parsed - What the adapter read from the stream.
 * @param started - The run's mock servers; null for a case with none.
 * @returns The log's text, null for a case with no servers, and `parsed` with the logged calls merged in when the
 *   stream shows none of them (`mergeMockLog`).
 */
export function withMockLog(
  harness: Pick<Harness, "capabilities">,
  parsed: Parsed,
  started: McpStarted | null,
): { parsed: Parsed; mcpLog: string | null } {
  if (started === null) return { parsed, mcpLog: null };
  const mcpLog = readLogText(started.staged.log);
  return {
    mcpLog,
    parsed: harness.capabilities.has("mcp")
      ? mergeMockLog(parsed, parseLog(mcpLog))
      : parsed,
  };
}
