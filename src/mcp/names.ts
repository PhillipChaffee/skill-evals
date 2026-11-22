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
