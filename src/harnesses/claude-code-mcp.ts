import fs from "node:fs";
import path from "node:path";
import type { McpRegistration, McpServerEntry } from "../mcp/types.js";

/** The file of the run's mock MCP directory that `--mcp-config` names. */
export const MCP_CONFIG = "mcp-config.json";
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
