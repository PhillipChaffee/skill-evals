import fs from "node:fs";
import path from "node:path";
import type { McpRegistration, McpServerEntry } from "../mcp/types.js";

/** The file of the run's mock MCP directory that `--mcp-config` names. */
const MCP_CONFIG = "servers.json";
const INDENT = 2;

/**
 * Writes the MCP config that Claude Code reads with `--mcp-config`: `{ "mcpServers": { <name>: { type, command, args,
 * env } } }`, the file form of the flag (`docs/design/mcp-mocks.md`).
 * @param servers - The mock servers, each with the command that starts it and the environment only it gets.
 * @param input - The run's mock directory, where the file goes.
 */
export function writeMcpConfig(
  servers: McpServerEntry[],
  input: McpRegistration,
): void {
  const mcpServers = Object.fromEntries(
    servers.map(({ name, command, args, env }) => [
      name,
      { type: "stdio", command, args, env },
    ]),
  );
  fs.writeFileSync(
    path.join(input.dir, MCP_CONFIG),
    JSON.stringify({ mcpServers }, null, INDENT),
  );
}

/**
 * Reads the state each MCP server reports in the init event.
 * @param servers - The init event's `mcp_servers`; absent when the event has none.
 * @returns Server name to its `status`, leaving out a server that states none; null when the event lists no servers.
 */
export function statusOfServers(
  servers: { name: string; status?: string }[] | undefined,
): Record<string, string> | null {
  return servers
    ? Object.fromEntries(
        servers.flatMap(({ name, status }) =>
          status === undefined ? [] : [[name, status]],
        ),
      )
    : null;
}

/**
 * Builds the flag that names a run's MCP config.
 * @param mcpDir - The run's mock directory; absent for a case with no mock servers.
 * @returns `--mcp-config <file>`, or nothing. The flag takes a list, so the caller puts it before another flag.
 */
export const mcpArgs = (mcpDir: string | undefined): string[] =>
  mcpDir ? ["--mcp-config", path.join(mcpDir, MCP_CONFIG)] : [];

/**
 * Builds the environment of a run with mock MCP servers.
 * @param mcpDir - The run's mock directory; absent for a case with no mock servers.
 * @returns `ENABLE_CLAUDEAI_MCP_SERVERS=false`, which the binary names as a way to turn off the loading of claude.ai
 *   connectors that a logged-in headless run would otherwise sync, so that a mock case reaches no real service; nothing
 *   for a case with none.
 */
export const mcpEnv = (mcpDir: string | undefined): Record<string, string> =>
  mcpDir ? { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } : {};

/**
 * Splits the name that Claude Code gives an MCP tool.
 * @param native - A tool name as the stream states it, such as `mcp__tracker__get_issue`.
 * @returns The server and the tool; null for a name that is not `mcp__<server>__<tool>`. The server is the part up to
 *   the next `__`, and the tool is everything after it, as the CLI splits it.
 */
export function mcpToolOf(
  native: string,
): { server: string; tool: string } | null {
  if (!native.startsWith("mcp__")) return null;
  const [, server = "", ...rest] = native.split("__");
  const tool = rest.join("__");
  return server === "" || tool === "" ? null : { server, tool };
}

/**
 * Names an MCP tool as Claude Code does, for a call that only the mock log shows.
 * @param server - The MCP server, as the case's `mcp/` directory names it.
 * @param tool - The tool of that server, as its spec file names it.
 * @returns `mcp__<server>__<tool>`.
 */
export const mcpToolName = (server: string, tool: string): string =>
  `mcp__${server}__${tool}`;
